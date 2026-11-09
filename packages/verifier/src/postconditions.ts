// Evaluate an IR Condition against a live Page. Used by the verifier after
// each replay to check that the terminal state of the workflow is actually
// what the IR claims it should be.
//
// The `responseStatus` condition is deliberately marked 'unsupported' here:
// evaluating it requires a navigation observer, which the bare Page
// interface does not expose. A future verifier revision can plumb this in,
// but marking it as unsupported is more honest than guessing.

import type { Condition } from '@sfysh/ir';
import type { Page } from '@sfysh/runtime';
import type { PostconditionResult } from './types.js';

export async function evaluateCondition(
  page: Page,
  condition: Condition,
): Promise<PostconditionResult> {
  if ('urlMatches' in condition) {
    const url = page.url();
    const pattern = condition.urlMatches;
    const matches = toRegex(pattern).test(url) || url.includes(pattern);
    return matches
      ? { condition, status: 'held' }
      : {
          condition,
          status: 'violated',
          reason: `URL '${url}' did not match '${pattern}'`,
        };
  }

  if ('urlEquals' in condition) {
    const url = page.url();
    return url === condition.urlEquals
      ? { condition, status: 'held' }
      : {
          condition,
          status: 'violated',
          reason: `URL '${url}' does not equal '${condition.urlEquals}'`,
        };
  }

  if ('selectorVisible' in condition) {
    const visible = await page.locator(condition.selectorVisible).isVisible();
    return visible
      ? { condition, status: 'held' }
      : {
          condition,
          status: 'violated',
          reason: `Selector '${condition.selectorVisible}' not visible`,
        };
  }

  if ('selectorAbsent' in condition) {
    const count = await page.locator(condition.selectorAbsent).count();
    return count === 0
      ? { condition, status: 'held' }
      : {
          condition,
          status: 'violated',
          reason: `Selector '${condition.selectorAbsent}' still present (${count} matches)`,
        };
  }

  if ('textPresent' in condition) {
    const count = await page.getByText(condition.textPresent).count();
    return count > 0
      ? { condition, status: 'held' }
      : {
          condition,
          status: 'violated',
          reason: `Text '${condition.textPresent}' not present`,
        };
  }

  if ('responseStatus' in condition) {
    return {
      condition,
      status: 'unsupported',
      reason: 'responseStatus checks require a navigation observer (not yet wired)',
    };
  }

  return {
    condition,
    status: 'unsupported',
    reason: 'Unknown condition shape',
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

function toRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    // Fall back to a literal substring matcher if the pattern isn't valid regex.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped);
  }
}
