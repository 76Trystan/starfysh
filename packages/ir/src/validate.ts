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
  if (ok) {
    return { valid: true, value: data as Workflow, errors: [] };
  }
  return {
    valid: false,
    value: undefined,
    errors: toErrors(compiledWorkflow.errors),
  };
}

/**
 * Validate an unknown value as a single Step.
 * Useful for patch-time validation inside the healer, which operates on one
 * step at a time rather than whole workflows.
 */
export function validateStep(data: unknown): ValidationResult<Step> {
  const ok = compiledStep(data);
  if (ok) {
    return { valid: true, value: data as Step, errors: [] };
  }
  return {
    valid: false,
    value: undefined,
    errors: toErrors(compiledStep.errors),
  };
}

/**
 * Boolean type-guard for use at package boundaries. Discards error detail;
 * prefer `validateWorkflow` when you need to report what went wrong.
 */
export function isWorkflow(data: unknown): data is Workflow {
  return compiledWorkflow(data) as boolean;
}

/**
 * Boolean type-guard for a single Step.
 */
export function isStep(data: unknown): data is Step {
  return compiledStep(data) as boolean;
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
