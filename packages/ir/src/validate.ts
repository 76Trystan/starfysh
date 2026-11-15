// Workflow and Step validation against the JSON Schemas in ./schema/.
// Returns typed, structured results. Never throws for validation failures;
// throws only if the schemas themselves are malformed (an internal error).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Workflow, Step } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(__dirname, 'schema');

const workflowSchema = JSON.parse(
  readFileSync(join(schemaDir, 'workflow.schema.json'), 'utf-8'),
) as Record<string, unknown>;

const stepSchema = JSON.parse(readFileSync(join(schemaDir, 'step.schema.json'), 'utf-8')) as Record<
  string,
  unknown
>;

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  verbose: false,
});
addFormats(ajv);

// Register the step schema under the URL that workflow's `./step.schema.json`
// $ref resolves to (relative to workflow's $id). This makes the cross-file
// reference resolvable without changing either schema file.
ajv.addSchema(stepSchema, 'https://sfysh.dev/schemas/v1/step.schema.json');

const compiledWorkflow = ajv.compile<Workflow>(workflowSchema);
const compiledStep = ajv.compile<Step>(stepSchema);

/**
 * A single validation error, projected into a stable, consumer-friendly shape.
 * The underlying Ajv error objects carry more detail; we expose the subset
 * that is useful for CLI messages, UI rendering, and the healer's triage.
 */
export interface ValidationError {
  /** JSON Pointer to the offending value within the input (`/` for the root). */
  path: string;
  /** Human-readable error message. */
  message: string;
  /** The schema keyword that failed (e.g. 'required', 'enum', 'pattern'). */
  keyword: string;
  /** Any additional context the schema provided (e.g. allowed values). */
  params: Record<string, unknown>;
}

export interface ValidationResult<T> {
  valid: boolean;
  value: T | undefined;
  errors: ValidationError[];
}

/**
 * Validate an unknown value as a Starfysh Workflow.
 * On success, `value` is typed as `Workflow` and `errors` is empty.
 * On failure, `value` is `undefined` and `errors` lists each problem.
 */
export function validateWorkflow(data: unknown): ValidationResult<Workflow> {
  const ok = compiledWorkflow(data);
  if (!ok) {
    return {
      valid: false,
      value: undefined,
      errors: toErrors(compiledWorkflow.errors),
    };
  }
  const errors = workflowSemanticErrors(data as Workflow);
  if (errors.length > 0) {
    return { valid: false, value: undefined, errors };
  }
  return { valid: true, value: data as Workflow, errors: [] };
}

/**
 * Validate an unknown value as a single Step.
 * Useful for patch-time validation inside the healer, which operates on one
 * step at a time rather than whole workflows.
 */
export function validateStep(data: unknown): ValidationResult<Step> {
  const ok = compiledStep(data);
  if (!ok) {
    return {
      valid: false,
      value: undefined,
      errors: toErrors(compiledStep.errors),
    };
  }
  const errors: ValidationError[] = [];
  walkSteps([data as Step], '', (step, path) => checkStepText(step, path, errors));
  checkUniqueStepIds([data as Step], '', errors);
  if (errors.length > 0) {
    return { valid: false, value: undefined, errors };
  }
  return { valid: true, value: data as Step, errors: [] };
}

/**
 * Boolean type-guard for use at package boundaries. Discards error detail;
 * prefer `validateWorkflow` when you need to report what went wrong.
 */
export function isWorkflow(data: unknown): data is Workflow {
  return validateWorkflow(data).valid;
}

/**
 * Boolean type-guard for a single Step.
 */
export function isStep(data: unknown): data is Step {
  return validateStep(data).valid;
}

// Rules the JSON Schema cannot express, or does not express yet. They run
// only after the schema check passes, so every value here already has the
// right shape.
//
// - Free-text fields (`intent`, `name`, `description`) must not contain
//   control characters. The compiler writes these into `//` comments, where
//   a line break would end the comment and turn the rest into code.
// - Step ids must be unique across the whole workflow, including steps
//   nested in `guard` and `loop` bodies. Patches and diffs address steps by
//   id, so a duplicate makes them ambiguous.
// - Every `{ secret }` and `{ param }` reference must be declared on the
//   workflow, so a workflow cannot read a secret it never asked for.
//
// The control-character and length rules move into the schema files with
// the next minor IR version. Until then the validator is stricter than the
// published schema.

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

type LooseStep = {
  id?: string;
  intent?: string;
  url?: unknown;
  value?: unknown;
  then?: Step[];
  else?: Step[];
  do?: Step[];
};

function workflowSemanticErrors(workflow: Workflow): ValidationError[] {
  const errors: ValidationError[] = [];

  checkText(workflow.name, '/name', errors);
  if (workflow.description !== undefined) {
    checkText(workflow.description, '/description', errors);
  }

  walkSteps(workflow.steps, '/steps', (step, path) => checkStepText(step, path, errors));
  checkUniqueStepIds(workflow.steps, '/steps', errors);

  const secrets = new Set<string>(workflow.secrets ?? []);
  const params = new Set<string>(Object.keys(workflow.parameters ?? {}));
  walkSteps(workflow.steps, '/steps', (step, path) => {
    for (const field of ['url', 'value'] as const) {
      const source = step[field];
      if (typeof source !== 'object' || source === null) continue;
      const ref = source as { secret?: string; param?: string };
      if (typeof ref.secret === 'string' && !secrets.has(ref.secret)) {
        errors.push({
          path: `${path}/${field}/secret`,
          message: `secret '${ref.secret}' is not declared in the workflow's secrets`,
          keyword: 'undeclaredSecret',
          params: { secret: ref.secret },
        });
      }
      if (typeof ref.param === 'string' && !params.has(ref.param)) {
        errors.push({
          path: `${path}/${field}/param`,
          message: `parameter '${ref.param}' is not declared in the workflow's parameters`,
          keyword: 'undeclaredParam',
          params: { param: ref.param },
        });
      }
    }
  });

  return errors;
}

/**
 * Visit every step depth-first, including steps nested in `guard` and
 * `loop` bodies. `path` is the JSON Pointer of the visited step.
 */
function walkSteps(
  steps: readonly Step[],
  basePath: string,
  visit: (step: LooseStep, path: string) => void,
): void {
  steps.forEach((raw, index) => {
    const step = raw as LooseStep;
    // A bare step (validateStep) has no array around it, so its pointer is
    // the base path itself.
    const path = basePath === '' ? '' : `${basePath}/${index}`;
    visit(step, path);
    for (const key of ['then', 'else', 'do'] as const) {
      const nested = step[key];
      if (Array.isArray(nested)) walkSteps(nested, `${path}/${key}`, visit);
    }
  });
}

function checkStepText(step: LooseStep, path: string, errors: ValidationError[]): void {
  if (typeof step.intent === 'string') checkText(step.intent, `${path}/intent`, errors);
}

function checkText(value: string, path: string, errors: ValidationError[]): void {
  if (CONTROL_CHARACTER.test(value)) {
    errors.push({
      path,
      message: 'must not contain control characters (line breaks, tabs, and similar)',
      keyword: 'controlCharacter',
      params: {},
    });
  }
}

function checkUniqueStepIds(
  steps: readonly Step[],
  basePath: string,
  errors: ValidationError[],
): void {
  const seen = new Map<string, string>();
  walkSteps(steps, basePath, (step, path) => {
    if (typeof step.id !== 'string') return;
    const first = seen.get(step.id);
    if (first === undefined) {
      seen.set(step.id, path);
      return;
    }
    errors.push({
      path: `${path}/id`,
      message: `step id '${step.id}' is already used at ${first || '/'}`,
      keyword: 'uniqueStepId',
      params: { id: step.id, firstSeenAt: first || '/' },
    });
  });
}

function toErrors(
  ajvErrors:
    | readonly {
        instancePath: string;
        message?: string;
        keyword: string;
        params: Record<string, unknown>;
      }[]
    | null
    | undefined,
): ValidationError[] {
  if (!ajvErrors) return [];
  return ajvErrors.map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'validation failed',
    keyword: e.keyword,
    params: e.params,
  }));
}
