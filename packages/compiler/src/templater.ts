// Handlebars-based templater that walks the IR and emits per-step code.
//
// Each step kind has its own template string registered on a private
// Handlebars instance. The templater is strict: an unknown step action
// is a compile error, not silently skipped.

import Handlebars from 'handlebars';
import { parseRoleSelector, planExtract } from '@sfysh/ir';
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
  hb.registerHelper('jsonLiteral', (value: unknown) => new hb.SafeString(jsLiteral(value)));

  const entries = Object.entries(STEP_TEMPLATES) as Array<[Step['action'], string]>;
  const stepTemplates = Object.fromEntries(
    entries.map(([action, source]) => [action, hb.compile(source, { noEscape: true })]),
  ) as Record<Step['action'], HandlebarsTemplateDelegate>;

  return new Templater(hb, stepTemplates);
}

/**
 * The variable element lookups start from. `page` everywhere except inside
 * a `foreach` body, where every target is looked up within the current
 * item. Conditions are always evaluated against the page.
 */
type Root = 'page' | 'item';

export class Templater {
  constructor(
    private readonly hb: typeof Handlebars,
    private readonly stepTemplates: Record<Step['action'], HandlebarsTemplateDelegate>,
  ) {}

  renderStep(step: Step, indent = '  ', root: Root = 'page'): string {
    const template = this.stepTemplates[step.action];
    if (!template) {
      throw new CompilerError(`Unknown step action: ${(step as { action: string }).action}`);
    }
    const context = buildStepContext(step, root);
    // Nested bodies are rendered here rather than through a partial so the
    // lookup root can change: a `foreach` body is scoped to its item.
    const nested = (steps: readonly Step[], r: Root): string =>
      steps.map((s) => this.renderStep(s, '  ', r)).join('\n\n');
    if (step.action === 'guard') {
      context.thenSource = nested(step.then, root);
      if (step.else) context.elseSource = nested(step.else, root);
    }
    if (step.action === 'loop') {
      context.doSource = nested(step.do, step.foreach ? 'item' : root);
    }
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
    // Every extract hands its value to the output sink, under its bind
    // name or, failing that, its step id. It does so after the post
    // checks, so a step whose postcondition fails contributes no output.
    const output =
      step.action === 'extract'
        ? `emit.output({ ${bind ?? step.id!}: ${bind ?? EXTRACT_LOCAL} });`
        : '';
    const inner = [pre, code, post, output, bind ? `return ${bind};` : '']
      .filter((s) => s.length > 0)
      .join('\n');
    const declaration = bind ? `const ${bind} = ` : '';
    // `timeoutMs` is enforced by the runtime's `step()`, the same way the
    // interpreter enforces it. Zero means no limit, as in the interpreter.
    const timeoutMs = (step as { timeoutMs?: number }).timeoutMs;
    const options = timeoutMs !== undefined && timeoutMs > 0 ? `, { timeoutMs: ${timeoutMs} }` : '';
    const assembled =
      `${comment}\n` +
      `${declaration}await step(ctx, ${jsLiteral(stepInfo(step))}, async () => {\n` +
      (inner.length > 0 ? `${indentLines(inner, '  ')}\n` : '') +
      `}${options});`;
    return indentLines(assembled, indent);
  }

  renderWorkflow(workflow: Workflow): string {
    checkBindNames(workflow.steps);
    const stepsSource = workflow.steps.map((step) => this.renderStep(step)).join('\n\n');
    return WORKFLOW_TEMPLATE({
      workflowId: workflow.id,
      workflowName: workflow.name,
      description: workflow.description ?? '',
      compilerVersion: COMPILER_HEADER_VERSION,
      destructure: computeContextDestructure(workflow),
      needsAssertCondition: containsConditionAsserts(workflow.steps),
      flowHelpers: flowHelpersUsed(workflow.steps),
      steps: stepsSource,
    });
  }
}

/** Iteration cap for a loop without `maxIterations`. The IR schema default, and the runtime's `DEFAULT_MAX_ITERATIONS`. */
const DEFAULT_MAX_ITERATIONS = 100;

/**
 * Names generated code already uses in the scope where a bind is declared.
 * A bind with one of these names would shadow it (`const page = ...`) or
 * fail to compile.
 */
const GENERATED_NAMES = new Set([
  'ctx',
  'page',
  'vault',
  'emit',
  'item',
  // EXTRACT_LOCAL, written out: that constant is declared further down.
  'extracted',
  'workflow',
  'step',
  'assert',
  'poll',
  'assertCondition',
  'conditionHolds',
  'forEachItem',
  'whileHolds',
]);

/** Reserved words, strict-mode reserved words, and globals a `const` must not take. */
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'arguments',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
  'globalThis',
]);

/**
 * Refuse `bind` names generated code cannot declare: reserved words, names
 * the generated function already uses, and a name bound twice. A repeat
 * would be a redeclaration in the same scope, or two extracts writing the
 * same output key.
 */
function checkBindNames(steps: readonly Step[], seen = new Map<string, string>()): void {
  for (const s of steps) {
    if (s.action === 'extract') {
      const bind = (s as { bind?: string }).bind;
      if (bind !== undefined) {
        if (RESERVED.has(bind)) {
          throw new CompilerError(
            `Extract step '${s.id}' binds '${bind}', which is a reserved word.`,
          );
        }
        if (GENERATED_NAMES.has(bind)) {
          throw new CompilerError(
            `Extract step '${s.id}' binds '${bind}', which generated code already uses. Choose another name.`,
          );
        }
        const earlier = seen.get(bind);
        if (earlier !== undefined) {
          throw new CompilerError(
            `Extract steps '${earlier}' and '${s.id}' both bind '${bind}'. Each bind name must be unique.`,
          );
        }
        seen.set(bind, s.id!);
      }
    }
    if (s.action === 'guard') {
      checkBindNames(s.then, seen);
      if (s.else) checkBindNames(s.else, seen);
    }
    if (s.action === 'loop') checkBindNames(s.do, seen);
  }
}

/** Which flow-control helpers the generated file must import. */
function flowHelpersUsed(steps: readonly Step[]): string[] {
  const used = new Set<string>();
  const walk = (list: readonly Step[]): void => {
    for (const s of list) {
      if (s.action === 'guard') {
        used.add('conditionHolds');
        walk(s.then);
        if (s.else) walk(s.else);
      }
      if (s.action === 'assert') used.add('conditionHolds');
      if (s.action === 'wait' && (s as { forCondition?: unknown }).forCondition) {
        used.add('conditionHolds');
      }
      if (s.action === 'loop') {
        used.add(s.foreach ? 'forEachItem' : 'whileHolds');
        walk(s.do);
      }
    }
  };
  walk(steps);
  return ['conditionHolds', 'forEachItem', 'whileHolds'].filter((name) => used.has(name));
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
  hb.registerHelper(
    'target',
    (target: Target, root: Root) => new hb.SafeString(renderTarget(target, root)),
  );
  hb.registerHelper('value', (value: ValueSource) => new hb.SafeString(renderValueSource(value)));
}

/**
 * Render a Target as a locator lookup from `root` (`page`, or `item` inside
 * a `foreach` body). Generated code uses the first candidate only; falling
 * through to the others is a later change.
 */
function renderTarget(target: Target, root: Root): string {
  const primary = target.candidates[0];
  if (!primary) {
    throw new CompilerError('Target has no candidates');
  }
  return renderSelector(primary, root);
}

function renderSelector(sel: SelectorCandidate, root: Root): string {
  switch (sel.kind) {
    case 'role':
      return renderRoleSelector(sel.value, root);
    case 'testid':
      return `${root}.getByTestId(${quote(sel.value)})`;
    case 'text':
      return `${root}.getByText(${quote(sel.value)})`;
    case 'label':
      return `${root}.getByLabel(${quote(sel.value)})`;
    case 'css':
      return `${root}.locator(${quote(sel.value)})`;
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
function renderRoleSelector(value: string, root: Root): string {
  // The format is parsed in @sfysh/ir so the interpreter reads it the same way.
  const { role, options, unparsed } = parseRoleSelector(value);
  if (unparsed.length > 0) {
    throw new CompilerError(
      `Role selector ${quote(value)} has parts that cannot be read: ${unparsed.map(quote).join(', ')}. ` +
        `Write attributes as name='value', level=2 or exact=true.`,
    );
  }
  const entries = Object.entries(options);
  if (entries.length === 0) {
    return `${root}.getByRole(${quote(role)})`;
  }
  const optionLiteral = `{ ${entries.map(([k, v]) => `${k}: ${jsLiteral(v)}`).join(', ')} }`;
  return `${root}.getByRole(${quote(role)}, ${optionLiteral})`;
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
 * Render a flow condition (guard `if`, wait `forCondition`, assert
 * `condition`, loop `while`) as a call to the runtime's `conditionHolds`,
 * which evaluates it exactly as pre and post checks are evaluated.
 * Conditions are always read from the page, also inside a `foreach` body.
 */
function renderFlowCondition(cond: Condition, stepId: string): string {
  if ('responseStatus' in cond) {
    throw new CompilerError(
      `responseStatus condition (${cond.responseStatus}) is not supported until Phase 2 response tracking is wired`,
    );
  }
  return `await conditionHolds(page, ${jsLiteral(cond)}, ${quote(stepId)})`;
}

/** A loop's `while` condition as a literal for `whileHolds`, which evaluates it itself. */
function flowConditionLiteral(cond: Condition): string {
  if ('responseStatus' in cond) {
    throw new CompilerError(
      `responseStatus condition (${cond.responseStatus}) is not supported until Phase 2 response tracking is wired`,
    );
  }
  return jsLiteral(cond);
}

/** Local variable an extract step without `bind` stores its value in. */
const EXTRACT_LOCAL = 'extracted';

function buildStepContext(step: Step, root: Root): Record<string, unknown> {
  const schema =
    step.action === 'extract' ? (step as { schema?: Record<string, unknown> }).schema : undefined;
  // The schema decides the read: one value, a flat list, or typed table
  // rows. The rule is shared with the interpreter through @sfysh/ir.
  const plan = step.action === 'extract' ? planExtract(schema) : undefined;
  if (plan?.kind === 'unsupported') {
    throw new CompilerError(`Extract step '${step.id}' cannot be compiled: ${plan.reason}`);
  }
  const flow = step as {
    if?: Condition;
    forCondition?: Condition;
    condition?: Condition;
    while?: Condition;
    maxIterations?: number;
  };
  const id = step.id!;
  return {
    ...step,
    root,
    stepIdLiteral: quote(id),
    maxIterations: flow.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    ifExpr: flow.if ? renderFlowCondition(flow.if, id) : undefined,
    forConditionExpr: flow.forCondition ? renderFlowCondition(flow.forCondition, id) : undefined,
    conditionExpr: flow.condition ? renderFlowCondition(flow.condition, id) : undefined,
    whileLiteral: flow.while ? flowConditionLiteral(flow.while) : undefined,
    intent: commentText((step as { intent?: string }).intent ?? ''),
    isNavigate: step.action === 'navigate',
    isClick: step.action === 'click',
    isFill: step.action === 'fill',
    isExtract: step.action === 'extract',
    isWait: step.action === 'wait',
    isAssert: step.action === 'assert',
    isGuard: step.action === 'guard',
    isLoop: step.action === 'loop',
    extractMethod: plan?.kind,
    extractColumns: plan?.kind === 'table' ? plan.columns : undefined,
    extractVar: (step as { bind?: string }).bind ?? EXTRACT_LOCAL,
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
await {{{target target root}}}.click();`,

  fill: `// [{{id}}] {{intent}}
await {{{target target root}}}.fill({{{value value}}});`,

  extract: `// [{{id}}] {{intent}}
const {{extractVar}} = await emit.{{extractMethod}}({{{target target root}}}{{#if extractColumns}}, {{{jsonLiteral extractColumns}}}{{/if}});`,

  wait: `// [{{id}}] {{intent}}
{{#if forConditionExpr}}await poll(async () => {{{forConditionExpr}}});{{/if}}{{#if millis}}await page.waitForTimeout({{millis}});{{/if}}`,

  assert: `// [{{id}}] {{intent}}
assert({{{conditionExpr}}});`,

  guard: `// [{{id}}] {{intent}}
if ({{{ifExpr}}}) {
{{{thenSource}}}
}{{#if elseSource}} else {
{{{elseSource}}}
}{{/if}}`,

  loop: `// [{{id}}] {{intent}}
{{#if foreach}}await forEachItem({{{stepIdLiteral}}}, {{maxIterations}}, await {{{target foreach root}}}.all(), async (item) => {
{{{doSource}}}
});{{/if}}{{#if while}}await whileHolds(page, {{{stepIdLiteral}}}, {{{whileLiteral}}}, {{maxIterations}}, async () => {
{{{doSource}}}
});{{/if}}`,
};

const WORKFLOW_TEMPLATE = (tpl: {
  workflowId: string;
  workflowName: string;
  description: string;
  compilerVersion: string;
  destructure: string[];
  needsAssertCondition: boolean;
  flowHelpers: string[];
  steps: string;
}): string => {
  const runtimeImports = ['workflow', 'step', 'assert', 'poll'];
  if (tpl.needsAssertCondition) runtimeImports.push('assertCondition');
  runtimeImports.push(...tpl.flowHelpers);
  return `// GENERATED by @sfysh/compiler v${tpl.compilerVersion} from workflow ${tpl.workflowId}
// Intent: ${commentText(tpl.workflowName)}${tpl.description ? '\n// Description: ' + commentText(tpl.description) : ''}
//
// Do not edit by hand. Changes should be made in the IR workflow source
// and re-compiled.

import { ${runtimeImports.join(', ')} } from '@sfysh/runtime';

workflow(${JSON.stringify(tpl.workflowId)}, async (ctx) => {
  const { ${tpl.destructure.join(', ')} } = ctx;

${tpl.steps}
});
`;
};
