// Shared IR Condition evaluator and the error type thrown by generated
// code when a pre or post condition is violated. Introduced by ADR 0011 so
// that generated workflow scripts evaluate pre/post inline (triggering
// triage on a silent failure) and the verifier reuses the same semantics
// through a re-export rather than a parallel implementation.
//
// The `responseStatus` condition stays `unsupported` here. Phase 2 wires
// `Page.lastResponse()` and the request-step response observer into this
// branch; flipping it from `unsupported` to live will be a one-place change.

import type { Condition } from '@sfysh/ir';
import type { Page } from './types.js';
import type { WorkflowContext } from './context.js';

/**
 * Shape returned by `evaluateCondition`. Deliberately narrower than the
 * verifier's `PostconditionResult`: it does not echo the condition back,
 * because the caller already has the condition in scope.
 */
export interface ConditionEvaluation {
  status: 'held' | 'violated' | 'unsupported';
  reason?: string;
}

/**
 * Evaluate an IR `Condition` against a live `Page`. Pure with respect to
 * the condition payload; the only state it reads is on the page.
 */
export async function evaluateCondition(
  page: Page,
  condition: Condition,
): Promise<ConditionEvaluation> {
  if ('urlMatches' in condition) {
    const url = page.url();
    const pattern = condition.urlMatches;
    const matches = toRegex(pattern).test(url) || url.includes(pattern);
    return matches
      ? { status: 'held' }
      : { status: 'violated', reason: `URL '${url}' did not match '${pattern}'` };
  }

  if ('urlEquals' in condition) {
    const url = page.url();
    return url === condition.urlEquals
      ? { status: 'held' }
      : { status: 'violated', reason: `URL '${url}' does not equal '${condition.urlEquals}'` };
  }

  if ('selectorVisible' in condition) {
    const visible = await page.locator(condition.selectorVisible).isVisible();
    return visible
      ? { status: 'held' }
      : { status: 'violated', reason: `Selector '${condition.selectorVisible}' not visible` };
  }

  if ('selectorAbsent' in condition) {
    const count = await page.locator(condition.selectorAbsent).count();
    return count === 0
      ? { status: 'held' }
      : {
          status: 'violated',
          reason: `Selector '${condition.selectorAbsent}' still present (${count} matches)`,
        };
  }

  if ('textPresent' in condition) {
    const count = await page.getByText(condition.textPresent).count();
    return count > 0
      ? { status: 'held' }
      : { status: 'violated', reason: `Text '${condition.textPresent}' not present` };
  }

  if ('responseStatus' in condition) {
    return {
      status: 'unsupported',
      reason: 'responseStatus checks require a navigation observer (not yet wired)',
    };
  }

  return { status: 'unsupported', reason: 'Unknown condition shape' };
}

/**
 * Error thrown by `assertCondition` when a pre or post condition is
 * violated. Carries the step id, phase, failing condition, and a human
 * reason so the healer and triage can route the failure without parsing
 * the message string.
 */
export class PostconditionViolation extends Error {
  readonly stepId: string;
  readonly phase: 'pre' | 'post';
  readonly condition: Condition;
  readonly reason: string;

  constructor(init: {
    stepId: string;
    phase: 'pre' | 'post';
    condition: Condition;
    reason: string;
  }) {
    super(`[${init.stepId}] ${init.phase} condition violated: ${init.reason}`);
    this.name = 'PostconditionViolation';
    this.stepId = init.stepId;
    this.phase = init.phase;
    this.condition = init.condition;
    this.reason = init.reason;
  }
}

/**
 * Evaluate a condition and throw `PostconditionViolation` if the result is
 * `violated`. `held` and `unsupported` pass silently. Called by generated
 * code in the pre/post slots around every step body.
 */
export async function assertCondition(
  ctx: WorkflowContext,
  stepId: string,
  phase: 'pre' | 'post',
  condition: Condition,
): Promise<void> {
  const result = await evaluateCondition(ctx.page, condition);
  if (result.status === 'violated') {
    throw new PostconditionViolation({
      stepId,
      phase,
      condition,
      reason: result.reason ?? 'condition did not hold',
    });
  }
}

function toRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped);
  }
}
