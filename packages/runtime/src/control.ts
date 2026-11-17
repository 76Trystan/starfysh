// Control flow helpers shared by generated code and the IR interpreter.
//
// Loops, step deadlines and flow conditions (guard, wait, assert, loop
// while) used to be written out differently by the two executors: the
// interpreter enforced `maxIterations` and `timeoutMs`, generated code
// ignored both, and generated code evaluated flow conditions with its own
// inline expressions where `urlMatches` meant a regex only. Each was a way
// for a workflow to pass verification and behave differently once
// compiled. Both executors now call these helpers, so there is one
// implementation of each rule.

import type { Condition } from '@sfysh/ir';
import { evaluateCondition } from './conditions.js';
import type { Locator, Page } from './types.js';

/** Iteration cap for a loop step that does not set `maxIterations`. Matches the IR schema default. */
export const DEFAULT_MAX_ITERATIONS = 100;

/** Thrown when a loop runs more iterations than its `maxIterations` cap. */
export class LoopLimitError extends Error {
  readonly maxIterations: number;

  constructor(stepId: string, maxIterations: number) {
    super(
      `loop '${stepId}' exceeded its cap of ${maxIterations} iterations. ` +
        `Raise 'maxIterations' on the step if the page really has that many.`,
    );
    this.name = 'LoopLimitError';
    this.maxIterations = maxIterations;
  }
}

/** Thrown when a step runs longer than its `timeoutMs`. */
export class StepTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(stepId: string, timeoutMs: number) {
    super(`step '${stepId}' did not finish within its timeoutMs of ${timeoutMs}ms`);
    this.name = 'StepTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when a flow condition cannot be evaluated against a page (for example `responseStatus`). */
export class UnsupportedConditionError extends Error {
  constructor(stepId: string, reason: string) {
    super(`step '${stepId}' uses a condition that cannot be evaluated: ${reason}`);
    this.name = 'UnsupportedConditionError';
  }
}

/**
 * Evaluate a condition that controls flow: a guard's `if`, a wait's
 * `forCondition`, an assert's `condition`, a loop's `while`. Uses the same
 * evaluator as pre and post checks, so a condition means the same thing
 * wherever it appears. Throws `UnsupportedConditionError` for a condition
 * the page cannot answer, rather than treating it as false.
 */
export async function conditionHolds(
  page: Page,
  condition: Condition,
  stepId: string,
): Promise<boolean> {
  const result = await evaluateCondition(page, condition);
  if (result.status === 'unsupported') {
    throw new UnsupportedConditionError(stepId, result.reason ?? 'unsupported');
  }
  return result.status === 'held';
}

/**
 * Run `body` once per item, in order, and fail with `LoopLimitError` on the
 * iteration after `maxIterations`. The items are read once, before the
 * first iteration.
 */
export async function forEachItem(
  stepId: string,
  maxIterations: number,
  items: readonly Locator[],
  body: (item: Locator) => Promise<void>,
): Promise<void> {
  let iterations = 0;
  for (const item of items) {
    if (++iterations > maxIterations) throw new LoopLimitError(stepId, maxIterations);
    await body(item);
  }
}

/**
 * Run `body` while `condition` holds, checking before each iteration, and
 * fail with `LoopLimitError` on the iteration after `maxIterations`.
 */
export async function whileHolds(
  page: Page,
  stepId: string,
  condition: Condition,
  maxIterations: number,
  body: () => Promise<void>,
): Promise<void> {
  let iterations = 0;
  while (await conditionHolds(page, condition, stepId)) {
    if (++iterations > maxIterations) throw new LoopLimitError(stepId, maxIterations);
    await body();
  }
}

/**
 * Run `body`, failing with `StepTimeoutError` if it takes longer than
 * `timeoutMs`. A missing or zero timeout means no limit. The body cannot be
 * cancelled, so after a timeout it may still be running against the page;
 * the run has failed by then and the caller is expected to dispose the page.
 */
export async function withTimeout<T>(
  stepId: string,
  timeoutMs: number | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return body();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = body();
  // If the timeout wins, the body's eventual rejection has no listener.
  work.catch(() => {});
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(stepId, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
