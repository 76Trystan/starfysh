// Shadow mode: what automatic acceptance would have done.
//
// Every model-written patch waits for a person today. Before any patch is
// accepted without one, there has to be evidence that the automatic rule
// agrees with people. Shadow mode collects it on real workflows: after the
// real decision, the same patch is decided again under the candidate
// automatic rule, and the result is kept beside the reviewer's eventual
// verdict. Nothing about the real decision changes.
//
// The shadow verdict is recorded, never shown to the reviewer. A person
// told "the machine would have accepted this" is nudged towards accepting
// it, and the agreement rate would then measure the nudge, not the rule.

import { decidePatch } from './accept.js';
import type { AcceptancePolicy, ApprovalReasonCode, DecidePatchInput } from './accept.js';
import { CONFIDENCE_HIGH } from './score.js';

/**
 * The automatic rule shadow mode tests by default: a verified selector
 * patch with no approval reasons, at or above the high-confidence score.
 * It is the strictest `auto` policy `decidePatch` allows.
 */
export const SHADOW_AUTO_POLICY: AcceptancePolicy = { mode: 'auto', minScore: CONFIDENCE_HIGH };

/** What a patch's decision would have been under the shadow policy. */
export interface ShadowDecision {
  /** The policy tested. */
  policy: AcceptancePolicy;
  /** True when the policy would have accepted the patch without a person. */
  eligible: boolean;
  /**
   * Why it would still have waited, when not eligible: the approval reason
   * codes, or `rejected` if the patch would not have been accepted at all.
   */
  reasons: (ApprovalReasonCode | 'rejected')[];
}

/**
 * Decide a patch again under `policy` (default `SHADOW_AUTO_POLICY`) and
 * report the result. Pure: takes the same input as `decidePatch`, with its
 * `policy` replaced.
 */
export function shadowDecision(
  input: Omit<DecidePatchInput, 'policy'>,
  policy: AcceptancePolicy = SHADOW_AUTO_POLICY,
): ShadowDecision {
  const decision = decidePatch({ ...input, policy });
  switch (decision.status) {
    case 'accepted':
      return { policy, eligible: true, reasons: [] };
    case 'awaiting_approval':
      return { policy, eligible: false, reasons: decision.reasons.map((r) => r.code) };
    case 'rejected':
      return { policy, eligible: false, reasons: ['rejected'] };
  }
}
