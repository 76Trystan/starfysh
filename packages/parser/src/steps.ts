import type { Step, Target, Condition } from '@sfysh/ir';
import type { CallChain, SourcePos } from './walker.js';
import { extractTarget } from './selectors.js';
import { unquote } from './selectors.js';
import { extractCondition } from './conditions.js';

/**
 * A `page.<method>(...)` call whose terminal method is not in the parser's
 * supported set. Surfaced so downstream tooling can tell the user which
 * actions were dropped rather than silently producing an incomplete workflow.
 * Phase 2 reuses this shape for unrecognised HTTP-library calls.
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
]);

export function chainsToSteps(chains: CallChain[]): ChainsToStepsResult {
  const steps: Step[] = [];
  const unsupported: UnsupportedCall[] = [];
  let counter = 0;

  for (const chain of chains) {
    if (chain.root === 'expect') {
      const condition = extractCondition(chain);
      if (!condition) continue;

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
      const step = pageChainToStep(chain.links, ++counter);
      if (step) steps.push(step);
    }
  }

  return { steps, unsupported };
}

function pageChainToStep(links: CallChain['links'], n: number): Step | undefined {
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
    default:
      return undefined;
  }
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
