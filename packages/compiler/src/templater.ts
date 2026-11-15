// Handlebars-based templater that walks the IR and emits per-step code.
//
// Each step kind has its own template string registered on a private
// Handlebars instance. The templater is strict: an unknown step action
// is a compile error, not silently skipped.

import Handlebars from 'handlebars';
import type { Step, Target, SelectorCandidate, ValueSource, Condition, Workflow } from '@sfysh/ir';
import { COMPILER_VERSION } from './version.js';

/**
 * Create a fresh Handlebars instance with helpers and templates registered.
 * Separate instance per compile keeps global state isolated, which matters
 * for the determinism test.
 */
export function createTemplater(): Templater {
  const hb = Handlebars.create();
  registerHelpers(hb);

  let self: Templater | null = null;
  hb.registerPartial('renderStep', (context: Step) => {
    return self!.renderStep(context);
  });
  hb.registerHelper('jsonLiteral', (value: unknown) => new hb.SafeString(jsLiteral(value)));

  const entries = Object.entries(STEP_TEMPLATES) as Array<[Step['action'], string]>;
  const stepTemplates = Object.fromEntries(
    entries.map(([action, source]) => [action, hb.compile(source, { noEscape: true })]),
  ) as Record<Step['action'], HandlebarsTemplateDelegate>;

  self = new Templater(hb, stepTemplates);
  return self;
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
    const body = template(context).trimEnd();
    // `id` is required by the schema and verified by validateWorkflow; the
    // non-null assertion covers the json-schema-to-typescript quirk where
    // allOf + CommonFields leaves `id` optional on the generated union.
    const pre = renderConditionAsserts(step.id!, 'pre', step.pre ?? []);
    const post = renderConditionAsserts(step.id!, 'post', step.post ?? []);

    // Every template starts with its `// [id] intent` provenance comment.
    // The comment stays outside the wrapper; everything after it runs inside
    // `step(...)`, so a failure anywhere in the step (pre check, action,
    // post check) is attributed to this step id and selector.
    const newline = body.indexOf('\n');
    const comment = newline === -1 ? body : body.slice(0, newline);
    const code = newline === -1 ? '' : body.slice(newline + 1);

    // An extract step with `bind` declares a variable later steps can read.
    // Declared inside the wrapper it would be out of scope, so the wrapper
    // returns it and the declaration moves outside.
    const bind = step.action === 'extract' ? (step as { bind?: string }).bind : undefined;
    const inner = [pre, code, post, bind ? `return ${bind};` : '']
      .filter((s) => s.length > 0)
      .join('\n');
    const declaration = bind ? `const ${bind} = ` : '';
    const assembled =
      `${comment}\n` +
      `${declaration}await step(ctx, ${jsLiteral(stepInfo(step))}, async () => {\n` +
      (inner.length > 0 ? `${indentLines(inner, '  ')}\n` : '') +
      `});`;
    return indentLines(assembled, indent);
  }

  renderWorkflow(workflow: Workflow): string {
    const stepsSource = workflow.steps.map((step) => this.renderStep(step)).join('\n\n');
    return WORKFLOW_TEMPLATE({
      workflowId: workflow.id,
      workflowName: workflow.name,
      description: workflow.description ?? '',
      compilerVersion: COMPILER_HEADER_VERSION,
      destructure: computeContextDestructure(workflow),
      needsAssertCondition: containsConditionAsserts(workflow.steps),
      hasOutputs: workflow.outputs !== undefined,
      steps: stepsSource,
    });
  }
}

/**
 * The attribution record passed to the runtime's `step()` wrapper: the step
 * id, its action kind, and the selector candidate the generated code uses
 * (always the first one today). Steps with no element target carry no
 * selector.
 */
function stepInfo(step: Step): Record<string, unknown> {
  const target =
    (step as { target?: Target }).target ??
    (step.action === 'loop' ? (step as { foreach?: Target }).foreach : undefined);
  const primary = target?.candidates[0];
  return {
    id: step.id,
    action: step.action,
    ...(primary ? { selector: { kind: primary.kind, value: primary.value } } : {}),
  };
}

/**
 * Render each condition in a `pre` or `post` array as an `assertCondition`
 * call. The runtime helper throws `PostconditionViolation` on a violated
 * result; `held` and `unsupported` pass silently (ADR 0011).
 */
function renderConditionAsserts(
  stepId: string,
  phase: 'pre' | 'post',
  conditions: readonly Condition[],
): string {
  if (conditions.length === 0) return '';
  return conditions
    .map(
      (c) =>
        `await assertCondition(ctx, ${JSON.stringify(stepId)}, ${JSON.stringify(phase)}, ${jsLiteral(c)});`,
    )
    .join('\n');
}

/**
 * Recursively check whether any step (including nested guard/loop bodies)
 * carries a non-empty `pre` or `post` array. Drives the conditional import
 * of `assertCondition` in the generated file.
 */
function containsConditionAsserts(steps: readonly Step[]): boolean {
  for (const step of steps) {
    if ((step.pre ?? []).length > 0 || (step.post ?? []).length > 0) return true;
    if (step.action === 'guard') {
      if (containsConditionAsserts(step.then)) return true;
      if (step.else && containsConditionAsserts(step.else)) return true;
    }
    if (step.action === 'loop') {
      if (containsConditionAsserts(step.do)) return true;
    }
  }
  return false;
}

/**
 * Decide which fields to pull off the WorkflowContext at the top of the
 * generated function. `page` is always present (every workflow uses it);
 * `vault` is included when the workflow declares secrets or any step reads
 * one; `emit` only
 * when the workflow contains an `extract` step (which is the only step
 * template that calls through the emit sink).
 */
function computeContextDestructure(workflow: Workflow): string[] {
  const fields = ['page'];
  if ((workflow.secrets ?? []).length > 0 || containsSecretValue(workflow.steps)) {
    fields.push('vault');
  }
  if (containsExtract(workflow.steps)) fields.push('emit');
  return fields;
}

/**
 * True when any step, at any depth, takes its `url` or `value` from a vault
 * secret. Validation already requires such secrets to be declared, so this
 * is a second line of defence: generated code never calls `vault()` without
 * having it in scope.
 */
function containsSecretValue(steps: readonly Step[]): boolean {
  for (const step of steps) {
    const { url, value } = step as { url?: unknown; value?: unknown };
    for (const source of [url, value]) {
      if (typeof source === 'object' && source !== null && 'secret' in source) return true;
    }
    if (step.action === 'guard') {
      if (containsSecretValue(step.then)) return true;
      if (step.else && containsSecretValue(step.else)) return true;
    }
    if (step.action === 'loop') {
      if (containsSecretValue(step.do)) return true;
    }
  }
  return false;
}

function containsExtract(steps: readonly Step[]): boolean {
  for (const step of steps) {
    if (step.action === 'extract') return true;
    if (step.action === 'guard') {
      if (containsExtract(step.then)) return true;
      if (step.else && containsExtract(step.else)) return true;
    }
    if (step.action === 'loop') {
      if (containsExtract(step.do)) return true;
    }
  }
  return false;
}

const COMPILER_HEADER_VERSION = COMPILER_VERSION;

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
    // The runtime context does not carry workflow parameters yet, so there
    // is nothing correct to emit. Failing here beats generating a script
    // that throws a ReferenceError on its first run.
    throw new CompilerError(
      `Parameter reference '${value.param}' cannot be compiled: workflow parameters are not supported by the runtime yet`,
    );
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
    throw new CompilerError(
      `responseStatus condition (${cond.responseStatus}) is not supported until Phase 2 response tracking is wired`,
    );
  }
  throw new CompilerError('Unknown Condition shape');
}

function buildStepContext(step: Step): Record<string, unknown> {
  const schema =
    step.action === 'extract' ? (step as { schema?: Record<string, unknown> }).schema : undefined;
  const isValueExtract = step.action === 'extract' && schema?.type === 'string';
  const isListExtract = step.action === 'extract' && schema?.type === 'array';
  return {
    ...step,
    intent: commentText((step as { intent?: string }).intent ?? ''),
    isNavigate: step.action === 'navigate',
    isClick: step.action === 'click',
    isFill: step.action === 'fill',
    isExtract: step.action === 'extract',
    isWait: step.action === 'wait',
    isAssert: step.action === 'assert',
    isGuard: step.action === 'guard',
    isLoop: step.action === 'loop',
    isValueExtract,
    isListExtract,
    isTableExtract: step.action === 'extract' && !isValueExtract && !isListExtract,
  };
}

// Built with the RegExp constructor so this source file never contains a
// raw line separator character.
const LINE_SEPARATOR = new RegExp('\\u2028', 'g');
const PARAGRAPH_SEPARATOR = new RegExp('\\u2029', 'g');
const COMMENT_UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+', 'g');

/**
 * Render any JSON-compatible value as a TypeScript literal. `JSON.stringify`
 * escapes quotes, backslashes, and every control character, so no string
 * inside the value can end its literal early. U+2028 and U+2029 are escaped
 * as well: they are legal inside a string literal but count as line breaks
 * elsewhere, and escaping them keeps the generated file free of raw line
 * separators. The formatter rewrites the double quotes to the pinned
 * single-quote style.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}

/** Render a string as a TypeScript string literal. See `jsLiteral`. */
function quote(s: string): string {
  return jsLiteral(s);
}

/**
 * Make free text safe to place after `//`. A line break of any kind would
 * end the comment and turn the rest of the text into code, so every control
 * character and Unicode line separator becomes a single space. The IR
 * validator already rejects most of these; the compiler does not rely on
 * that, because the comment is the last point where the text can do harm.
 */
function commentText(s: string): string {
  return s.replace(COMMENT_UNSAFE, ' ');
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
{{#if isValueExtract}}{{#if bind}}const {{bind}} = {{/if}}await emit.value({{{target target}}});{{else if isListExtract}}{{#if bind}}const {{bind}} = {{/if}}await emit.list({{{target target}}});{{else}}{{#if bind}}const {{bind}} = {{/if}}await emit.table({{{target target}}}, {{{jsonLiteral schema}}});{{/if}}`,

  wait: `// [{{id}}] {{intent}}
{{#if forCondition}}await poll(async () => {{{cond forCondition}}});{{/if}}{{#if millis}}await page.waitForTimeout({{millis}});{{/if}}`,

  assert: `// [{{id}}] {{intent}}
assert({{{cond condition}}});`,

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

const WORKFLOW_TEMPLATE = (tpl: {
  workflowId: string;
  workflowName: string;
  description: string;
  compilerVersion: string;
  destructure: string[];
  needsAssertCondition: boolean;
  hasOutputs: boolean;
  steps: string;
}): string => {
  const runtimeImports = ['workflow', 'step', 'assert', 'poll'];
  if (tpl.needsAssertCondition) runtimeImports.push('assertCondition');
  return `// GENERATED by @sfysh/compiler v${tpl.compilerVersion} from workflow ${tpl.workflowId}
// Intent: ${commentText(tpl.workflowName)}${tpl.description ? '\n// Description: ' + commentText(tpl.description) : ''}
//
// Do not edit by hand. Changes should be made in the IR workflow source
// and re-compiled.

import { ${runtimeImports.join(', ')} } from '@sfysh/runtime';

workflow(${JSON.stringify(tpl.workflowId)}, async (ctx) => {
  const { ${tpl.destructure.join(', ')} } = ctx;

${tpl.steps}
${tpl.hasOutputs ? '\n  await ctx.flushOutputs();\n' : ''}});
`;
};
