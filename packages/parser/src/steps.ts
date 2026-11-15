import type { Step, Target, Condition } from '@sfysh/ir';
import type { CallChain, ForOfLoop, WalkerItem, SourcePos } from './walker.js';
import { extractTarget } from './selectors.js';
import { unquote } from './selectors.js';
import { extractCondition } from './conditions.js';

/**
 * A call the parser recognised syntactically but could not map into the IR.
 * Two shapes land here: a `page.<method>(...)` chain whose terminal method is
 * not in the parser's supported set, and an `expect(...)` chain whose matcher
 * (or subject, or argument) the condition extractor could not translate. In
 * both cases `method` is the terminal method of the chain (`hover`,
 * `toHaveCount`, ...). Surfaced so downstream tooling can tell the user which
 * actions and assertions were dropped rather than silently producing an
 * incomplete workflow. Phase 2 reuses this shape for unrecognised
 * HTTP-library calls; one list rather than a page/expect split keeps that
 * extension a pure addition.
 */
export interface UnsupportedCall {
  method: string;
  position: SourcePos;
  text: string;
}

/**
 * Something the parser changed or noticed that the author should review.
 * Warnings never carry the literal value they are about, so they are safe
 * to print.
 *
 * - `literal-secret`: a `fill` on a field that looks like a credential had
 *   a literal value. The parser replaced it with a vault reference named
 *   `secret` and declared that name on the workflow. The value must be
 *   supplied through the vault at run time.
 * - `literal-fill`: a `fill` kept its literal value in the IR. Harmless for
 *   ordinary input, but worth a look in case the field is sensitive and the
 *   parser did not recognise it.
 */
export interface ParseWarning {
  kind: 'literal-secret' | 'literal-fill';
  stepId: string;
  position: SourcePos;
  message: string;
  /** Vault secret name the literal was replaced with. Only on `literal-secret`. */
  secret?: string;
}

export interface ChainsToStepsResult {
  steps: Step[];
  unsupported: UnsupportedCall[];
  warnings: ParseWarning[];
  /** Vault secret names introduced by lifting literal credentials. */
  secrets: string[];
}

/**
 * State shared across one parse, including nested loop bodies. A single
 * counter keeps step ids unique across the whole workflow.
 */
interface ParseState {
  counter: number;
  warnings: ParseWarning[];
  secrets: string[];
}

// Field names that suggest a credential. Matched against the locator
// arguments of a `fill` chain. Errs towards matching: a false positive costs
// the author one vault entry, a false negative puts a password in the IR.
const CREDENTIAL_FIELD_RE =
  /pass(?:word|wd|code|phrase)|pwd|\bpass\b|secret|token|\botp\b|api[-_ ]?key|\bpin\b|cvv|cvc/i;

const SUPPORTED_PAGE_METHODS: ReadonlySet<string> = new Set([
  'goto',
  'click',
  'fill',
  'waitForTimeout',
  'waitForSelector',
  'waitForURL',
  'textContent',
  'innerText',
  'inputValue',
  'allTextContents',
]);

// Playwright locator terminals that read data out of the page. The parser
// emits an `extract` IR step for each, with a weak default schema. Column-
// type inference lands in a later ToDo item; today the schemas are the
// loosest shape that still gates output-stability comparisons.
const EXTRACT_SCHEMAS: ReadonlyMap<string, { readonly type: 'string' | 'array' }> = new Map([
  ['textContent', { type: 'string' as const }],
  ['innerText', { type: 'string' as const }],
  ['inputValue', { type: 'string' as const }],
  ['allTextContents', { type: 'array' as const }],
]);

const BIND_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function chainsToSteps(chains: readonly WalkerItem[]): ChainsToStepsResult {
  const state: ParseState = { counter: 0, warnings: [], secrets: [] };
  const { steps, unsupported } = walkChains(chains, state);
  return { steps, unsupported, warnings: state.warnings, secrets: state.secrets };
}

function walkChains(
  chains: readonly WalkerItem[],
  state: ParseState,
): { steps: Step[]; unsupported: UnsupportedCall[] } {
  const steps: Step[] = [];
  const unsupported: UnsupportedCall[] = [];

  for (const item of chains) {
    if ('kind' in item && item.kind === 'for-of') {
      const result = forOfToStep(item, ++state.counter, state);
      if (result?.step) steps.push(result.step);
      unsupported.push(...(result?.unsupported ?? []));
      continue;
    }

    const chain = item as CallChain;

    if (chain.root === 'expect') {
      const condition = extractCondition(chain);
      if (!condition) {
        // The matcher, its subject, or its argument could not be mapped to an
        // IR Condition. Report the terminal method (the matcher name) so the
        // user sees exactly which assertion fell out of the workflow.
        const terminal = chain.links[chain.links.length - 1];
        unsupported.push({
          method: terminal?.method ?? 'expect',
          position: chain.position,
          text: chain.text,
        });
        continue;
      }

      const prev = steps[steps.length - 1];
      if (prev) {
        prev.post = prev.post ?? [];
        prev.post.push(condition);
      } else {
        state.counter++;
        steps.push({
          id: stepId('assert', state.counter),
          intent: describeCondition(condition),
          action: 'assert' as const,
          condition,
        } as Step);
      }
      continue;
    }

    if (chain.root === 'page') {
      const terminal = chain.links[chain.links.length - 1];
      if (terminal && !SUPPORTED_PAGE_METHODS.has(terminal.method)) {
        unsupported.push({
          method: terminal.method,
          position: chain.position,
          text: chain.text,
        });
        continue;
      }
      const step = pageChainToStep(chain, ++state.counter, state);
      if (step) steps.push(step);
    }
  }

  return { steps, unsupported };
}

function pageChainToStep(chain: CallChain, n: number, state: ParseState): Step | undefined {
  const { links } = chain;
  const terminal = links[links.length - 1];
  if (!terminal) return undefined;

  switch (terminal.method) {
    case 'goto':
      return gotoStep(terminal.args, n);
    case 'click':
      return clickStep(links, n);
    case 'fill':
      return fillStep(chain, terminal.args, n, state);
    case 'waitForTimeout':
      return waitTimeoutStep(terminal.args, n);
    case 'waitForSelector':
      return waitSelectorStep(terminal.args, n);
    case 'waitForURL':
      return waitUrlStep(terminal.args, n);
    case 'textContent':
    case 'innerText':
    case 'inputValue':
    case 'allTextContents':
      return extractStep(chain, terminal.method, n);
    default:
      return undefined;
  }
}

function extractStep(chain: CallChain, method: string, n: number): Step | undefined {
  const target = extractTarget(chain.links);
  if (!target) return undefined;

  const shape = EXTRACT_SCHEMAS.get(method);
  if (!shape) return undefined;

  const schema =
    shape.type === 'array' ? { type: 'array', items: { type: 'string' } } : { type: 'string' };

  const base: Record<string, unknown> = {
    id: stepId('extract', n),
    intent: describeExtract(method, target, chain.bind),
    action: 'extract' as const,
    target,
    schema,
  };
  if (chain.bind && BIND_RE.test(chain.bind)) {
    base.bind = chain.bind;
  }
  return base as Step;
}

function describeExtract(method: string, target: Target, bind?: string): string {
  const what = describeTarget(target);
  const action =
    method === 'allTextContents'
      ? `Extract all text contents of ${what}`
      : method === 'inputValue'
        ? `Extract input value of ${what}`
        : `Extract text of ${what}`;
  if (bind && BIND_RE.test(bind)) return `${action} into ${bind}`;
  return action;
}

function gotoStep(args: string[], n: number): Step | undefined {
  const url = unquote(args[0] ?? '');
  if (url === undefined) return undefined;
  return {
    id: stepId('navigate', n),
    intent: `Navigate to ${url}`,
    action: 'navigate' as const,
    url,
  } as Step;
}

function clickStep(links: CallChain['links'], n: number): Step | undefined {
  const target = extractTarget(links);
  if (!target) return undefined;
  return {
    id: stepId('click', n),
    intent: `Click ${describeTarget(target)}`,
    action: 'click' as const,
    target,
  } as Step;
}

function fillStep(
  chain: CallChain,
  terminalArgs: string[],
  n: number,
  state: ParseState,
): Step | undefined {
  const { links } = chain;
  const target = extractTarget(links);
  if (!target) return undefined;
  const literal = unquote(terminalArgs[0] ?? '');
  if (literal === undefined) return undefined;

  const id = stepId('fill', n);
  const field = describeTarget(target);
  let value: string | { secret: string } = literal;

  // Literal secrets must never enter the IR. A script that types a password
  // inline would otherwise carry it into the workflow file, the generated
  // code, and any cassette. When the field looks like a credential, the
  // literal is dropped and replaced with a vault reference.
  const locatorText = links
    .slice(0, -1)
    .map((link) => link.args.join(' '))
    .join(' ');
  if (CREDENTIAL_FIELD_RE.test(locatorText)) {
    const secret = secretNameFor(target, n);
    if (!state.secrets.includes(secret)) state.secrets.push(secret);
    value = { secret };
    state.warnings.push({
      kind: 'literal-secret',
      stepId: id,
      position: chain.position,
      secret,
      message: `Literal value for ${field} looks like a credential. Replaced with vault secret '${secret}'; supply the value through the vault at run time.`,
    });
  } else {
    state.warnings.push({
      kind: 'literal-fill',
      stepId: id,
      position: chain.position,
      message: `Literal value for ${field} was copied into the workflow. If this field is sensitive, replace it with a vault secret.`,
    });
  }

  return {
    id,
    intent: `Fill ${field}`,
    action: 'fill' as const,
    target,
    value,
  } as Step;
}

/**
 * Derive a vault secret name from the field a credential is typed into.
 * `getByLabel('Password')` becomes `password`; `#login-pass` becomes
 * `login_pass`. The result always satisfies the IR's secret-name pattern.
 * Two fills on the same field share one name, which is the intent: they are
 * the same secret.
 */
function secretNameFor(target: Target, n: number): string {
  const primary = target.candidates[0];
  const raw = primary?.value ?? '';
  // For role selectors, the accessible name is the meaningful part.
  const named = /\[name='([^']*)'\]/.exec(raw)?.[1] ?? raw;
  let slug = named
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '');
  if (!/^[a-z]/.test(slug)) slug = slug ? `secret_${slug}`.slice(0, 64) : '';
  if (slug.length < 3) slug = `secret_${String(n).padStart(3, '0')}`;
  return slug;
}

function waitTimeoutStep(args: string[], n: number): Step | undefined {
  const raw = args[0]?.trim();
  if (!raw) return undefined;
  const ms = parseInt(raw, 10);
  if (Number.isNaN(ms)) return undefined;
  return {
    id: stepId('wait', n),
    intent: `Wait for ${ms}ms`,
    action: 'wait' as const,
    millis: ms,
  } as Step;
}

function waitSelectorStep(args: string[], n: number): Step | undefined {
  const sel = unquote(args[0] ?? '');
  if (sel === undefined) return undefined;
  return {
    id: stepId('wait', n),
    intent: `Wait for ${sel} to be visible`,
    action: 'wait' as const,
    forCondition: { selectorVisible: sel } as Condition,
  } as Step;
}

function waitUrlStep(args: string[], n: number): Step | undefined {
  const url = unquote(args[0] ?? '');
  if (url === undefined) return undefined;
  return {
    id: stepId('wait', n),
    intent: `Wait for URL to match ${url}`,
    action: 'wait' as const,
    forCondition: { urlMatches: url } as Condition,
  } as Step;
}

function stepId(action: string, n: number): string {
  return `${action}_${String(n).padStart(3, '0')}`;
}

function describeTarget(target: Target): string {
  const primary = target.candidates[0];
  if (!primary) return 'element';
  switch (primary.kind) {
    case 'role':
      return primary.value;
    case 'testid':
      return `[data-testid="${primary.value}"]`;
    case 'text':
      return `text '${primary.value}'`;
    case 'label':
      return `field '${primary.value}'`;
    case 'css':
      return primary.value;
    default:
      return 'element';
  }
}

function forOfToStep(
  loop: ForOfLoop,
  n: number,
  state: ParseState,
): { step: Step | undefined; unsupported: UnsupportedCall[] } | undefined {
  const target = extractTarget(loop.iterable.links);
  if (!target) return undefined;

  const varRe = new RegExp(`\\b${loop.variable}\\.`, 'g');
  const remapped = loop.body.map((chain) => {
    if (chain.root === loop.variable) return { ...chain, root: 'page' };
    if (chain.root === 'expect') {
      return {
        ...chain,
        links: chain.links.map((link) => ({
          ...link,
          args: link.args.map((arg) => arg.replace(varRe, 'page.')),
        })),
      };
    }
    return chain;
  });

  const bodyResult = walkChains(remapped, state);

  if (bodyResult.steps.length === 0) {
    return bodyResult.unsupported.length > 0
      ? { step: undefined, unsupported: bodyResult.unsupported }
      : undefined;
  }

  const step: Step = {
    id: stepId('loop', n),
    intent: `Iterate over ${describeTarget(target)}`,
    action: 'loop' as const,
    foreach: target,
    do: bodyResult.steps as [Step, ...Step[]],
  } as Step;

  return { step, unsupported: bodyResult.unsupported };
}

function describeCondition(condition: Condition): string {
  if ('textPresent' in condition) return `Assert text '${condition.textPresent}' is present`;
  if ('selectorVisible' in condition) return `Assert ${condition.selectorVisible} is visible`;
  if ('selectorAbsent' in condition) return `Assert ${condition.selectorAbsent} is absent`;
  if ('urlEquals' in condition) return `Assert URL equals ${condition.urlEquals}`;
  if ('urlMatches' in condition) return `Assert URL matches ${condition.urlMatches}`;
  if ('responseStatus' in condition) return `Assert response status is ${condition.responseStatus}`;
  return 'Assert condition';
}
