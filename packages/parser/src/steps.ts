import type { Step, Target, Condition } from '@sfysh/ir';
import type { CallChain, SourcePos } from './walker.js';
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

export interface ChainsToStepsResult {
  steps: Step[];
  unsupported: UnsupportedCall[];
}

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

export function chainsToSteps(chains: CallChain[]): ChainsToStepsResult {
  const steps: Step[] = [];
  const unsupported: UnsupportedCall[] = [];
  let counter = 0;

  for (const chain of chains) {
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
        counter++;
        steps.push({
          id: stepId('assert', counter),
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
      const step = pageChainToStep(chain, ++counter);
      if (step) steps.push(step);
    }
  }

  return { steps, unsupported };
}

function pageChainToStep(chain: CallChain, n: number): Step | undefined {
  const { links } = chain;
  const terminal = links[links.length - 1];
  if (!terminal) return undefined;

  switch (terminal.method) {
    case 'goto':
      return gotoStep(terminal.args, n);
    case 'click':
      return clickStep(links, n);
    case 'fill':
      return fillStep(links, terminal.args, n);
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

function fillStep(links: CallChain['links'], terminalArgs: string[], n: number): Step | undefined {
  const target = extractTarget(links);
  if (!target) return undefined;
  const value = unquote(terminalArgs[0] ?? '');
  if (value === undefined) return undefined;
  return {
    id: stepId('fill', n),
    intent: `Fill ${describeTarget(target)}`,
    action: 'fill' as const,
    target,
    value,
  } as Step;
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

function describeCondition(condition: Condition): string {
  if ('textPresent' in condition) return `Assert text '${condition.textPresent}' is present`;
  if ('selectorVisible' in condition) return `Assert ${condition.selectorVisible} is visible`;
  if ('selectorAbsent' in condition) return `Assert ${condition.selectorAbsent} is absent`;
  if ('urlEquals' in condition) return `Assert URL equals ${condition.urlEquals}`;
  if ('urlMatches' in condition) return `Assert URL matches ${condition.urlMatches}`;
  if ('responseStatus' in condition) return `Assert response status is ${condition.responseStatus}`;
  return 'Assert condition';
}
