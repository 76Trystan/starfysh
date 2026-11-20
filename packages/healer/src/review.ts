// The review: everything a person needs to approve or refuse a patch, as
// plain text.
//
// The order is the order a reviewer needs it in: what was decided and why
// a person is being asked, then what the patch changes, then the evidence
// (verification and score), then the model's own explanation last, marked
// as the model's, because it is the least trustworthy part.

import type { Workflow } from '@sfysh/ir';
import type { PatchDecision } from './accept.js';
import { printable, renderSemanticDiff, semanticDiff } from './diff.js';

/**
 * A model-reported confidence below this puts a "the model was not sure"
 * line near the top of the review. Every false heal in the first real-model
 * benchmark runs was reported below it, alongside many correct heals, so the
 * line asks for a careful read and is not a verdict.
 */
export const DOUBT_CONFIDENCE_BELOW = 0.7;

// Phrases in which the model asks a person to check its choice, or says the
// page did not settle it. An English word list, kept narrow on purpose: a
// match only adds a warning line, it never changes a decision.
const DOUBT_PHRASES =
  /\b(?:please (?:confirm|check|verify)|(?:reviewer|person) should (?:confirm|check|verify)|(?:does not|doesn't|did not|didn't|cannot|can't|could not|couldn't) (?:confirm|tell|show which)|not sure|unsure|unclear which)\b/i;

/** Why the review warns that the model doubted its own patch; empty when it did not. */
function modelDoubt(patch: PatchDecision['patch']): string[] {
  const reasons: string[] = [];
  if (typeof patch.confidence === 'number' && patch.confidence < DOUBT_CONFIDENCE_BELOW) {
    reasons.push(
      `it reported a confidence of ${patch.confidence.toFixed(2)} (below ${DOUBT_CONFIDENCE_BELOW.toFixed(1)})`,
    );
  }
  if (DOUBT_PHRASES.test(patch.rationale)) {
    reasons.push('its explanation asks a person to check the choice');
  }
  return reasons;
}

export interface RenderReviewOptions {
  /** The workflow the patch was written against. Gives an insert's anchor step its intent. */
  workflow?: Workflow;
}

/** Render a decision from `decidePatch`, `approvePatch` or `heal()` for a reviewer. */
export function renderReview(decision: PatchDecision, options: RenderReviewOptions = {}): string {
  const { patch } = decision;
  const sections: string[] = [];

  const status =
    decision.status === 'awaiting_approval'
      ? 'waiting for approval'
      : decision.status === 'accepted'
        ? decision.acceptedBy.kind === 'policy'
          ? 'accepted automatically by policy'
          : `accepted by ${printable(decision.acceptedBy.reviewer)} at ${printable(decision.acceptedBy.at)}`
        : 'rejected';
  sections.push(
    `Heal of workflow ${printable(patch.workflowId)}, step ${printable(patch.stepId)}: ${status}.`,
  );

  // Straight after the status, so a reviewer cannot skim past it to the
  // diff. Not shown for a rejected patch, which nobody will approve.
  if (decision.status !== 'rejected') {
    const doubt = modelDoubt(patch);
    if (doubt.length > 0) {
      sections.push(
        `The model was not sure: ${doubt.join(', and ')}. Read its explanation at the end before approving, and check the element it chose is the one the step means.`,
      );
    }
  }

  if (decision.status === 'rejected') {
    const lines = [printable(decision.message)];
    for (const v of decision.violations ?? []) {
      lines.push(
        `  - ${printable(v.check)}/${printable(v.code)} at ${printable(v.path || '/')}: ${printable(v.message)}`,
      );
    }
    if (decision.verification?.status === 'failed') {
      for (const f of decision.verification.failures) {
        lines.push(`  - ${printable(f.code)}: ${printable(f.message)}`);
      }
    }
    sections.push(lines.join('\n'));
  }

  if (decision.status === 'awaiting_approval') {
    const lines = ['Why a person must look:'];
    for (const r of decision.reasons) lines.push(`  - ${printable(r.message, 600)}`);
    if (decision.approvals.length > 0) {
      lines.push('Confirm before approving:');
      for (const a of decision.approvals) lines.push(`  - ${printable(a.message)}`);
    }
    sections.push(lines.join('\n'));
  }

  sections.push(renderSemanticDiff(semanticDiff(patch, options.workflow)));

  if (decision.status !== 'rejected') {
    const { report } = decision;
    const partial =
      decision.status === 'awaiting_approval' &&
      decision.reasons.some((r) => r.code === 'partial_heal');
    const lines = [
      partial
        ? `Verification: none of the ${report.runs} live runs reached the end. Each passed the patched step, then failed at the same later step, and the outputs it gave before failing matched the start of the last known-good run.`
        : `Verification: ${report.passed} of ${report.runs} live runs passed, and every run's outputs matched the last known-good run.`,
    ];
    lines.push(
      `Timing: ${Math.round(report.timing.minMs)} to ${Math.round(report.timing.maxMs)} ms per run.`,
    );
    const { score } = decision;
    lines.push(
      `Confidence: ${score.score.toFixed(2)} (${score.level}), worked out from the page snapshot.`,
    );
    for (const s of score.signals) {
      const sign = s.effect > 0 ? '+' : s.effect < 0 ? '-' : ' ';
      lines.push(
        `  ${sign}${Math.abs(s.effect).toFixed(2)} ${printable(s.code)}: ${printable(s.detail)}`,
      );
    }
    if (score.modelConfidence !== undefined) {
      lines.push(
        `  The model reported ${score.modelConfidence.toFixed(2)}; it can lower the score, never raise it.`,
      );
    }
    sections.push(lines.join('\n'));
  }

  sections.push(
    `The model's explanation (unverified): ${JSON.stringify(printable(patch.rationale, 2000))}`,
  );

  return sections.join('\n\n') + '\n';
}
