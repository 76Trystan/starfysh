// One call that runs every patch check.
//
// The four checks are separate functions so each has its own codes and
// tests. Code that decides whether a patch may go ahead should call this
// instead, so that it cannot run three of them and forget the fourth.

import type { StepPatch, Workflow } from '@sfysh/ir';
import { checkPatchClass } from './allowlist.js';
import type { PatchClass } from './allowlist.js';
import { checkPatchPatterns } from './pattern.js';
import { checkPatchReach } from './reach.js';
import type { ReachApproval } from './reach.js';
import { checkPatchScope } from './scope.js';

/** Which check a violation came from. */
export type PatchCheckName = 'scope' | 'class' | 'reach' | 'pattern';

export interface PatchViolation {
  check: PatchCheckName;
  /** The code the check gave it, for example `post_weakened`. */
  code: string;
  /** JSON Pointer within the patch. */
  path: string;
  /** What is wrong. Does not quote patch content. */
  message: string;
}

/**
 * Only `ok` means the patch may go ahead on its own. `needs_approval`
 * means it broke no rule but must not be accepted until a person has
 * confirmed each listed point.
 */
export type PatchVerdict =
  | { status: 'ok' }
  | { status: 'needs_approval'; approvals: ReachApproval[] }
  | { status: 'rejected'; violations: PatchViolation[] };

/**
 * Run every check on a patch: scope, the allowlist for its class, origins
 * and secrets, and URL patterns. All four always run, so a rejected patch
 * comes back with everything that is wrong with it. A violation from any
 * check rejects the patch, whatever the others said.
 */
export function checkPatch(
  patch: StepPatch,
  workflow: Workflow,
  patchClass: PatchClass,
): PatchVerdict {
  const violations: PatchViolation[] = [];

  const scope = checkPatchScope(patch, workflow);
  if (!scope.ok) for (const v of scope.violations) violations.push({ check: 'scope', ...v });

  const allowed = checkPatchClass(patch, workflow, patchClass);
  if (!allowed.ok) for (const v of allowed.violations) violations.push({ check: 'class', ...v });

  const reach = checkPatchReach(patch, workflow);
  if (reach.status === 'rejected') {
    for (const v of reach.violations) violations.push({ check: 'reach', ...v });
  }

  const patterns = checkPatchPatterns(patch, workflow);
  if (!patterns.ok) {
    for (const v of patterns.violations) violations.push({ check: 'pattern', ...v });
  }

  if (violations.length > 0) return { status: 'rejected', violations };
  if (reach.status === 'needs_approval') {
    return { status: 'needs_approval', approvals: reach.approvals };
  }
  return { status: 'ok' };
}
