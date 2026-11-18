// Ranked selector candidates at run time.
//
// Every IR target carries its candidates in rank order (role, testid,
// label, text, css). Generated code and the IR interpreter both act on an
// element through `tryCandidates`: the action is tried with each candidate
// in turn until one succeeds. A step that only succeeds on a fallback is a
// pass, but a degraded one: the primary selector no longer works, and the
// next redesign may take the fallback too. Each degraded step is recorded
// on the run's context so the caller can report it and the healer can
// promote the candidate that worked, before the workflow fails outright.

import type { SelectorCandidate } from '@sfysh/ir';
import type { WorkflowContext } from './context.js';
import type { StepInfo } from './step.js';
import type { Locator } from './types.js';

/** One candidate a step may act through. */
export interface CandidateLookup {
  /** Position in the step's ranked list. 0 is the primary. */
  index: number;
  selector: SelectorCandidate;
  /** Builds the locator. Called only when this candidate is tried. */
  locate: () => Locator;
}

/** A step that passed on a fallback candidate rather than its primary. */
export interface DegradedStep {
  stepId: string;
  /** Position of the candidate that worked. Always greater than 0. */
  candidateIndex: number;
  /** The candidate that worked. */
  selector: SelectorCandidate;
}

/**
 * Run `action` against each candidate in order until one succeeds.
 *
 * The action is attempted for real each time, not probed first, so the
 * backend's own waiting applies: an element that is still rendering is not
 * mistaken for a missing one. The cost is that a broken primary fails
 * only after the backend's own timeout, before the next candidate is
 * tried.
 *
 * `info.selector` and `info.candidateIndex` are updated as each candidate
 * is tried, so a failure is attributed to the selector in use. If every
 * candidate fails, the primary's error is thrown and the attribution is
 * put back on the primary: that is the selector the step was written for,
 * and the one a heal starts from.
 *
 * A pass on a candidate after the first is recorded with
 * `ctx.recordDegraded`.
 */
export async function tryCandidates(
  ctx: WorkflowContext,
  info: StepInfo,
  candidates: readonly CandidateLookup[],
  action: (locator: Locator) => Promise<void>,
): Promise<void> {
  const first = candidates[0];
  if (first === undefined) throw new Error(`step '${info.id}' has no selector candidates to try`);

  let firstError: unknown;
  for (const candidate of candidates) {
    info.selector = { kind: candidate.selector.kind, value: candidate.selector.value };
    info.candidateIndex = candidate.index;
    try {
      await action(candidate.locate());
    } catch (err) {
      if (firstError === undefined) firstError = err;
      continue;
    }
    if (candidate.index > 0) {
      ctx.recordDegraded({
        stepId: info.id,
        candidateIndex: candidate.index,
        selector: { kind: candidate.selector.kind, value: candidate.selector.value },
      });
    }
    return;
  }

  info.selector = { kind: first.selector.kind, value: first.selector.value };
  info.candidateIndex = first.index;
  throw firstError;
}
