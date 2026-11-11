// Evaluate an IR Condition against a live Page. The core evaluator moved
// into `@sfysh/runtime` under ADR 0011 so generated workflow code can share
// it; the verifier keeps its own entry point for backwards compatibility
// and to wrap the result in its `PostconditionResult` shape.
//
// The `responseStatus` condition is still `unsupported` here: evaluating
// it requires a navigation observer, which the bare Page interface does
// not expose. Phase 2's response-tracking work flips this to live in one
// place (runtime), and the verifier inherits the change.

import type { Condition } from '@sfysh/ir';
import { evaluateCondition as evaluateConditionRuntime, type Page } from '@sfysh/runtime';
import type { PostconditionResult } from './types.js';

export async function evaluateCondition(
  page: Page,
  condition: Condition,
): Promise<PostconditionResult> {
  const result = await evaluateConditionRuntime(page, condition);
  if (result.status === 'held') {
    return { condition, status: 'held' };
  }
  return {
    condition,
    status: result.status,
    reason:
      result.reason ?? (result.status === 'violated' ? 'condition did not hold' : 'unsupported'),
  };
}

export async function evaluateConditions(
  page: Page,
  conditions: Condition[],
): Promise<PostconditionResult[]> {
  const results: PostconditionResult[] = [];
  for (const c of conditions) {
    results.push(await evaluateCondition(page, c));
  }
  return results;
}
