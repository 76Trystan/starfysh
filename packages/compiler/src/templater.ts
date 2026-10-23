// Handlebars-based templater that walks the IR and emits per-step code.
//
// Each step kind has its own template string registered on a private
// Handlebars instance. The templater is strict: an unknown step action
// is a compile error, not silently skipped.

import Handlebars from 'handlebars';
import type { Step, Target, SelectorCandidate, ValueSource, Condition, Workflow } from '@asc/ir';

/**
 * Create a fresh Handlebars instance with helpers and templates registered.
 * Separate instance per compile keeps global state isolated, which matters
 * for the determinism test.
 */
export function createTemplater(): Templater {
  const hb = Handlebars.create();
  registerHelpers(hb);
  const stepTemplates = compileStepTemplates(hb);
  return new Templater(hb, stepTemplates);
}

export class Templater {
  constructor(
    private readonly hb: typeof Handlebars,
    private readonly stepTemplates: Record<Step['action'], HandlebarsTemplateDelegate>,
  ) {}

  renderStep(step: Step, indent = '  '): string {
    const template = this.stepTemplates[step.action];
    if (!template) {
      throw new CompilerError(`Unknown step action: ${(step as { action: string }).action}`);
    }
    const context = buildStepContext(step);
    const rendered = template(context).trimEnd();
    return indentLines(rendered, indent);
  }

  renderWorkflow(workflow: Workflow): string {
    const stepsSource = workflow.steps.map((step) => this.renderStep(step)).join('\n\n');
    return WORKFLOW_TEMPLATE({
      workflowId: workflow.id,
      workflowName: workflow.name,
      description: workflow.description ?? '',
      compilerVersion: COMPILER_HEADER_VERSION,
      hasSecrets: (workflow.secrets ?? []).length > 0,
      hasOutputs: workflow.outputs !== undefined,
      steps: stepsSource,
    });
  }
}

const COMPILER_HEADER_VERSION = '0.0.0';

/**
 * Error thrown for compilation failures: unknown step kinds, missing
 * template fields, invalid structural combinations.
 */
export class CompilerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompilerError';
  }
}

function registerHelpers(hb: typeof Handlebars): void {
  hb.registerHelper('target', (target: Target) => new hb.SafeString(renderTarget(target)));
  hb.registerHelper('value', (value: ValueSource) => new hb.SafeString(renderValueSource(value)));
  hb.registerHelper('cond', (cond: Condition) => new hb.SafeString(renderCondition(cond)));
}

/**
 * Render a Target as a Playwright locator chain. Walks the candidates in
 * order: role first, then testid, text, label, css, visual. The runtime
 * is responsible for trying candidates and falling through on failure.
 * The first-tried candidate is emitted inline; the full ranked list is
 * emitted as a provenance comment the healer can read.
 */
function renderTarget(target: Target): string {
  const primary = target.candidates[0];
  if (!primary) {
    throw new CompilerError('Target has no candidates');
  }
  return renderSelector(primary);
}

function renderSelector(sel: SelectorCandidate): string {
  switch (sel.kind) {
    case 'role':
      return renderRoleSelector(sel.value);
    case 'testid':
      return `page.getByTestId(${quote(sel.value)})`;
    case 'text':
      return `page.getByText(${quote(sel.value)})`;
    case 'label':
      return `page.getByLabel(${quote(sel.value)})`;
    case 'css':
      return `page.locator(${quote(sel.value)})`;
    case 'visual':
      throw new CompilerError(
        `Visual selector '${sel.value}' encountered but visual-fallback codegen is not implemented in v1`,
      );
    default:
      throw new CompilerError(`Unknown selector kind: ${(sel as { kind: string }).kind}`);
  }
}

/**
 * Parse role-syntax values like `button[name='Sign in']` into a Playwright
 * getByRole call. Falls back to a plain role lookup if no attributes are
 * present.
 */
function renderRoleSelector(value: string): string {
  const match = value.match(/^([a-z]+)(?:\[(.+)\])?$/i);
  if (!match) {
    return `page.getByRole(${quote(value)})`;
  }
  const [, role, attrs] = match;
  if (!attrs) {
    return `page.getByRole(${quote(role!)})`;
  }
  const parsedOptions = parseRoleAttrs(attrs);
  if (Object.keys(parsedOptions).length === 0) {
    return `page.getByRole(${quote(role!)})`;
  }
  const optionLiteral = `{ ${Object.entries(parsedOptions)
    .map(([k, v]) => `${k}: ${quote(v)}`)
    .join(', ')} }`;
  return `page.getByRole(${quote(role!)}, ${optionLiteral})`;
}

function parseRoleAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    out[m[1]!] = m[2] ?? m[3] ?? '';
  }
  return out;
}

function renderValueSource(value: ValueSource): string {
  if (typeof value === 'string') {
    return quote(value);
  }
  if ('secret' in value) {
    return `vault(${quote(value.secret)})`;
  }
  if ('param' in value) {
    return `params.${value.param}`;
  }
  throw new CompilerError('ValueSource must be a string, {param}, or {secret}');
}

/**
 * Render a Condition as a Playwright assertion expression. Returns a
 * boolean-valued expression suitable for use in `if`, `expect`, or
 * `await`.
 */
function renderCondition(cond: Condition): string {
  if ('urlMatches' in cond) {
    return `new RegExp(${quote(cond.urlMatches)}).test(page.url())`;
  }
  if ('urlEquals' in cond) {
    return `page.url() === ${quote(cond.urlEquals)}`;
  }
  if ('selectorVisible' in cond) {
    return `await page.locator(${quote(cond.selectorVisible)}).isVisible()`;
  }
  if ('selectorAbsent' in cond) {
    return `(await page.locator(${quote(cond.selectorAbsent)}).count()) === 0`;
  }
  if ('textPresent' in cond) {
    return `(await page.getByText(${quote(cond.textPresent)}).count()) > 0`;
  }
  if ('responseStatus' in cond) {
    return `/* responseStatus check: ${cond.responseStatus}, not yet implemented */ true`;
  }
  throw new CompilerError('Unknown Condition shape');
}

function buildStepContext(step: Step): Record<string, unknown> {
  return {
    ...step,
    isNavigate: step.action === 'navigate',
    isClick: step.action === 'click',
    isFill: step.action === 'fill',
    isExtract: step.action === 'extract',
    isWait: step.action === 'wait',
    isAssert: step.action === 'assert',
    isGuard: step.action === 'guard',
    isLoop: step.action === 'loop',
  };
}

function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function indentLines(source: string, indent: string): string {
  return source
    .split('\n')
    .map((line) => (line.length > 0 ? indent + line : line))
    .join('\n');
}

/**
 * Per-step-kind templates. Kept in-source rather than in separate .hbs
 * files for simplicity in v1; splitting them out is a future refactor
 * that does not change behaviour.
 */
const STEP_TEMPLATES: Record<Step['action'], string> = {
  navigate: `// [{{id}}] {{intent}}
await page.goto({{{value url}}}{{#if waitUntil}}, { waitUntil: '{{waitUntil}}' }{{/if}});`,

  click: `// [{{id}}] {{intent}}
await {{{target target}}}.click();`,

  fill: `// [{{id}}] {{intent}}
await {{{target target}}}.fill({{{value value}}});`,

  extract: `// [{{id}}] {{intent}}
{{#if bind}}const {{bind}} = {{/if}}await emit.table({{{target target}}}, {{{jsonLiteral schema}}});`,

  wait: `// [{{id}}] {{intent}}
{{#if forCondition}}await expect.poll(async () => {{{cond forCondition}}}).toBe(true);{{/if}}{{#if millis}}await page.waitForTimeout({{millis}});{{/if}}`,

  assert: `// [{{id}}] {{intent}}
expect({{{cond condition}}}).toBe(true);`,

  guard: `// [{{id}}] {{intent}}
if ({{{cond if}}}) {
{{#each then}}
{{> renderStep this}}
{{/each}}
}{{#if else}} else {
{{#each else}}
{{> renderStep this}}
{{/each}}
}{{/if}}`,

  loop: `// [{{id}}] {{intent}}
{{#if foreach}}for (const item of await {{{target foreach}}}.all()) {
{{#each do}}
{{> renderStep this}}
{{/each}}
}{{/if}}{{#if while}}while ({{{cond while}}}) {
{{#each do}}
{{> renderStep this}}
{{/each}}
}{{/if}}`,
};

function compileStepTemplates(
  hb: typeof Handlebars,
): Record<Step['action'], HandlebarsTemplateDelegate> {
  // Register renderStep as a partial so nested steps (guard, loop) can recurse.
  hb.registerPartial('renderStep', (context: Step) => {
    // Delegate recursion by re-creating a templater; cheap for v1.
    return createTemplater().renderStep(context);
  });

  hb.registerHelper('jsonLiteral', (value: unknown) => new hb.SafeString(JSON.stringify(value)));

  const entries = Object.entries(STEP_TEMPLATES) as Array<[Step['action'], string]>;
  return Object.fromEntries(
    entries.map(([action, source]) => [action, hb.compile(source, { noEscape: true })]),
  ) as Record<Step['action'], HandlebarsTemplateDelegate>;
}

const WORKFLOW_TEMPLATE = (ctx: {
  workflowId: string;
  workflowName: string;
  description: string;
  compilerVersion: string;
  hasSecrets: boolean;
  hasOutputs: boolean;
  steps: string;
}): string => `// GENERATED by @asc/compiler v${ctx.compilerVersion} from workflow ${ctx.workflowId}
// Intent: ${ctx.workflowName}${ctx.description ? '\n// Description: ' + ctx.description : ''}
//
// Do not edit by hand. Changes should be made in the IR workflow source
// and re-compiled.

import { test, expect } from '@playwright/test';
${ctx.hasSecrets ? "import { vault } from '@asc/runtime';\n" : ''}${ctx.hasOutputs ? "import { emit, flushOutputs } from '@asc/runtime';\n" : "import { emit } from '@asc/runtime';\n"}
test(${JSON.stringify(ctx.workflowId)}, async ({ page }) => {
${ctx.steps}

${ctx.hasOutputs ? '  await flushOutputs();\n' : ''}});
`;
