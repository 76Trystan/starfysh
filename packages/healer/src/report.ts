// The corpus, summarised: what the healer did, how often it was wrong, and
// how often the automatic rule agrees with people.
//
// Three numbers matter, and each is defined here once:
//
// - False-heal rate (ADR 0004). Of the verified heals with a ground-truth
//   label of `correct` or `false_heal`, the share labelled `false_heal`.
//   Unlabelled heals are counted and shown, never assumed correct: a rate
//   over a small labelled share says so. False heals that reached the
//   workflow (applied) are counted separately; they are the ones that did
//   damage.
// - Shadow agreement (ADR 0034). For model-written heals with a shadow
//   verdict and a human answer, how often "would have auto-accepted"
//   matched the person. A person said no if they rejected the patch,
//   reverted it, or labelled it a false heal; yes if they approved it and
//   none of those followed. The cell that decides whether auto mode is
//   ever safe is "would accept, person said no".
// - Score bands (ADR 0022). Outcomes by confidence score, to see whether
//   false heals and rejections cluster at low scores before any threshold
//   is trusted.
//
// Pure: takes records, returns numbers. No values from pages appear.

import type { PatchClass } from './allowlist.js';
import type {
  CorpusAttempt,
  CorpusRecord,
  HealCorpusRecord,
  LabelCorpusRecord,
  LabelVerdict,
  ReviewCorpusRecord,
} from './corpus.js';

/** Lower bounds of the score bands, matching `CONFIDENCE_MEDIUM` and `CONFIDENCE_HIGH`. */
export const SCORE_BANDS = [
  { band: 'below 0.5', min: -Infinity },
  { band: '0.5 to 0.8', min: 0.5 },
  { band: '0.8 and above', min: 0.8 },
] as const;

export type ScoreBand = (typeof SCORE_BANDS)[number]['band'];

export interface FalseHealSummary {
  /** Verified heals labelled `false_heal`. */
  falseHeals: number;
  /** Verified heals labelled `correct`. */
  correct: number;
  /** Verified heals labelled `unknown`. */
  unknown: number;
  /** Verified heals with no label at all. */
  unlabelled: number;
  /** `falseHeals / (falseHeals + correct)`, or null when nothing is labelled. */
  rate: number | null;
  /** False heals that were applied to the workflow (by policy or approval). */
  appliedFalseHeals: number;
}

export interface ShadowSummary {
  /** Would have auto-accepted, and the person said yes. Agreement. */
  acceptedAndApproved: number;
  /** Would have auto-accepted, and the person said no. The dangerous cell. */
  acceptedButRejected: number;
  /** Would have held it, and the person said yes. The rule was too cautious. */
  heldButApproved: number;
  /** Would have held it, and the person said no. Agreement. */
  heldAndRejected: number;
  /** Shadow verdicts with no human answer yet. */
  awaitingAnswer: number;
  /** Share of answered heals where the rule and the person agreed, or null. */
  agreement: number | null;
}

export interface ScoreBandSummary {
  band: ScoreBand;
  /** Verified heals whose decided patch scored in this band. */
  heals: number;
  approved: number;
  rejected: number;
  reverted: number;
  falseHeals: number;
  correct: number;
}

export interface ReportSummary {
  /** Heal records, whatever their outcome. */
  heals: number;
  byTrigger: { failure: number; degraded: number };
  /** Heal records by outcome status (`decided`, `not_healed`, `routed`, ...). */
  outcomes: Record<string, number>;
  /** Heals with a verified, decided patch. */
  verified: number;
  /** Decided heals waiting for a person, with no answer yet. */
  pending: number;
  /** Latest human answer per heal. */
  approved: number;
  rejected: number;
  reverted: number;
  /** Heals whose patch reached the workflow. */
  applied: { total: number; byPolicy: number; byReviewer: number };
  /** Verified heals held because their outputs left the known-good envelope. */
  possiblyFalseHeals: number;
  falseHeal: FalseHealSummary;
  shadow: ShadowSummary;
  scoreBands: ScoreBandSummary[];
  /** Model tokens across every heal. */
  tokens: { input: number; output: number };
}

export interface CorpusReport {
  overall: ReportSummary;
  byWorkflow: Record<string, ReportSummary>;
  /** By the class of the decided patch. Heals with no decided patch are not in any class. */
  byPatchClass: Partial<Record<PatchClass, ReportSummary>>;
  /** Review and label records whose heal is not in the corpus. */
  orphans: number;
}

/** What is known about one heal, gathered from its heal, review and label records. */
interface HealFacts {
  record: HealCorpusRecord;
  decided?: CorpusAttempt;
  reviews: ReviewCorpusRecord[];
  label?: LabelVerdict;
}

/** Summarise a corpus. Records may come in any order; reviews and labels are applied in time order. */
export function corpusReport(records: readonly CorpusRecord[]): CorpusReport {
  const heals = new Map<string, HealFacts>();
  for (const r of records) {
    if (r.kind === 'heal') heals.set(r.id, { record: r, reviews: [], decided: decidedAttempt(r) });
  }
  let orphans = 0;
  const later = records
    .filter((r): r is ReviewCorpusRecord | LabelCorpusRecord => r.kind !== 'heal')
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const r of later) {
    const facts = heals.get(r.healId);
    if (facts === undefined) {
      orphans++;
      continue;
    }
    if (r.kind === 'review') facts.reviews.push(r);
    else facts.label = r.verdict;
  }

  const all = [...heals.values()];
  const byWorkflow: Record<string, ReportSummary> = {};
  for (const id of [...new Set(all.map((f) => f.record.workflowId))].sort()) {
    byWorkflow[id] = summarise(all.filter((f) => f.record.workflowId === id));
  }
  const byPatchClass: Partial<Record<PatchClass, ReportSummary>> = {};
  for (const cls of ['selector', 'insert_step', 'promotion'] as const) {
    const group = all.filter((f) => f.decided?.patchClass === cls);
    if (group.length > 0) byPatchClass[cls] = summarise(group);
  }
  return { overall: summarise(all), byWorkflow, byPatchClass, orphans };
}

function summarise(group: readonly HealFacts[]): ReportSummary {
  const summary: ReportSummary = {
    heals: group.length,
    byTrigger: { failure: 0, degraded: 0 },
    outcomes: {},
    verified: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    reverted: 0,
    applied: { total: 0, byPolicy: 0, byReviewer: 0 },
    possiblyFalseHeals: 0,
    falseHeal: {
      falseHeals: 0,
      correct: 0,
      unknown: 0,
      unlabelled: 0,
      rate: null,
      appliedFalseHeals: 0,
    },
    shadow: {
      acceptedAndApproved: 0,
      acceptedButRejected: 0,
      heldButApproved: 0,
      heldAndRejected: 0,
      awaitingAnswer: 0,
      agreement: null,
    },
    scoreBands: SCORE_BANDS.map(({ band }) => ({
      band,
      heals: 0,
      approved: 0,
      rejected: 0,
      reverted: 0,
      falseHeals: 0,
      correct: 0,
    })),
    tokens: { input: 0, output: 0 },
  };

  for (const facts of group) {
    const { record, decided, label } = facts;
    summary.byTrigger[record.trigger === 'degraded' ? 'degraded' : 'failure']++;
    summary.outcomes[record.outcome.status] = (summary.outcomes[record.outcome.status] ?? 0) + 1;
    summary.tokens.input += record.usage.inputTokens;
    summary.tokens.output += record.usage.outputTokens;

    const latest = facts.reviews.at(-1)?.verdict;
    if (latest === 'approved') summary.approved++;
    if (latest === 'rejected') summary.rejected++;
    if (latest === 'reverted') summary.reverted++;
    if (decided === undefined) continue;

    summary.verified++;
    const byPolicy = decided.decision?.status === 'accepted';
    const byReviewer = facts.reviews.some((r) => r.verdict === 'approved');
    const applied = byPolicy || byReviewer;
    if (applied) {
      summary.applied.total++;
      if (byPolicy) summary.applied.byPolicy++;
      else summary.applied.byReviewer++;
    }
    if (!applied && facts.reviews.length === 0) summary.pending++;
    if (decided.verification?.envelope?.status === 'outside') summary.possiblyFalseHeals++;

    if (label === 'false_heal') {
      summary.falseHeal.falseHeals++;
      if (applied) summary.falseHeal.appliedFalseHeals++;
    } else if (label === 'correct') summary.falseHeal.correct++;
    else if (label === 'unknown') summary.falseHeal.unknown++;
    else summary.falseHeal.unlabelled++;

    // A person's answer: no if rejected, reverted or labelled a false heal;
    // yes if approved and none of those followed.
    const said: 'yes' | 'no' | undefined =
      latest === 'rejected' || latest === 'reverted' || label === 'false_heal'
        ? 'no'
        : byReviewer
          ? 'yes'
          : undefined;
    const shadow = decided.wouldAutoAccept;
    if (shadow !== undefined) {
      if (said === undefined) summary.shadow.awaitingAnswer++;
      else if (shadow.eligible && said === 'yes') summary.shadow.acceptedAndApproved++;
      else if (shadow.eligible) summary.shadow.acceptedButRejected++;
      else if (said === 'yes') summary.shadow.heldButApproved++;
      else summary.shadow.heldAndRejected++;
    }

    const score = decided.score?.score;
    if (score !== undefined) {
      let index = 0;
      SCORE_BANDS.forEach(({ min }, i) => {
        if (score >= min) index = i;
      });
      const band = summary.scoreBands[index]!;
      band.heals++;
      if (latest === 'approved') band.approved++;
      if (latest === 'rejected') band.rejected++;
      if (latest === 'reverted') band.reverted++;
      if (label === 'false_heal') band.falseHeals++;
      if (label === 'correct') band.correct++;
    }
  }

  const labelled = summary.falseHeal.falseHeals + summary.falseHeal.correct;
  summary.falseHeal.rate = labelled === 0 ? null : summary.falseHeal.falseHeals / labelled;
  const s = summary.shadow;
  const answered =
    s.acceptedAndApproved + s.acceptedButRejected + s.heldButApproved + s.heldAndRejected;
  s.agreement = answered === 0 ? null : (s.acceptedAndApproved + s.heldAndRejected) / answered;
  return summary;
}

/** The attempt whose patch was decided on (accepted or held), if any. */
function decidedAttempt(record: HealCorpusRecord): CorpusAttempt | undefined {
  for (let i = record.attempts.length - 1; i >= 0; i--) {
    const status = record.attempts[i]!.decision?.status;
    if (status === 'accepted' || status === 'awaiting_approval') return record.attempts[i];
  }
  return undefined;
}

/** Render a report as plain text. Every number is shown with what it is out of. */
export function renderReport(report: CorpusReport, options: { workflow?: string } = {}): string {
  const lines: string[] = [];
  const section = (title: string, s: ReportSummary) => {
    lines.push(title);
    lines.push(
      `  Heals: ${s.heals} (${s.byTrigger.failure} from failures, ${s.byTrigger.degraded} promotions of degraded runs). Outcomes: ${formatCounts(s.outcomes)}.`,
    );
    lines.push(
      `  Verified: ${s.verified}. Applied: ${s.applied.total} (${s.applied.byReviewer} approved by a person, ${s.applied.byPolicy} by policy). Waiting: ${s.pending}. Rejected: ${s.rejected}. Reverted: ${s.reverted}.`,
    );
    lines.push(`  Held as possible false heals: ${s.possiblyFalseHeals}.`);
    const f = s.falseHeal;
    const labelled = f.falseHeals + f.correct;
    lines.push(
      f.rate === null
        ? `  False-heal rate: not measured (no verified heal is labelled correct or false_heal; ${f.unlabelled} unlabelled).`
        : `  False-heal rate: ${percent(f.rate)} (${f.falseHeals} of ${labelled} labelled verified heals; ${f.unlabelled} unlabelled, ${f.unknown} labelled unknown). Applied false heals: ${f.appliedFalseHeals}.`,
    );
    const sh = s.shadow;
    const answered =
      sh.acceptedAndApproved + sh.acceptedButRejected + sh.heldButApproved + sh.heldAndRejected;
    lines.push(
      sh.agreement === null
        ? `  Shadow agreement: not measured (${sh.awaitingAnswer} shadow verdicts awaiting a person's answer).`
        : `  Shadow agreement: ${percent(sh.agreement)} of ${answered} answered. Would accept: ${sh.acceptedAndApproved} approved, ${sh.acceptedButRejected} rejected. Would hold: ${sh.heldButApproved} approved, ${sh.heldAndRejected} rejected. Awaiting: ${sh.awaitingAnswer}.`,
    );
    for (const b of s.scoreBands) {
      if (b.heals === 0) continue;
      lines.push(
        `  Score ${b.band}: ${b.heals} heals; ${b.approved} approved, ${b.rejected} rejected, ${b.reverted} reverted; labelled ${b.correct} correct, ${b.falseHeals} false.`,
      );
    }
    lines.push(`  Model tokens: ${s.tokens.input} in, ${s.tokens.output} out.`);
  };

  if (options.workflow !== undefined) {
    const s = report.byWorkflow[options.workflow];
    if (s === undefined) return `No heals recorded for workflow ${options.workflow}.`;
    section(`Workflow ${options.workflow}`, s);
    return lines.join('\n');
  }

  section('All workflows', report.overall);
  for (const [cls, s] of Object.entries(report.byPatchClass)) {
    lines.push('');
    section(`Patch class ${cls}`, s);
  }
  for (const [id, s] of Object.entries(report.byWorkflow)) {
    lines.push('');
    section(`Workflow ${id}`, s);
  }
  if (report.orphans > 0) {
    lines.push('', `${report.orphans} review or label records point at heals not in the corpus.`);
  }
  return lines.join('\n');
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k} ${v}`).join(', ');
}
