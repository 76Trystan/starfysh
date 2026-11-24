// The published report for a drift heal run, built from results.json.
//
// The format was fixed on 2026-11-18, before any real numbers existed, so
// that it could not be chosen to flatter a result. The rules it follows:
//
// - Every figure carries its denominator, and every rate a 95% Wilson
//   interval, because the counts are small.
// - Results are split by case group. The case mix is our choice, so a
//   single pooled rate would partly measure that choice and hide where the
//   failures cluster.
// - Every row is shown, including bad ones. The decoy-trap row is always
//   shown, even when it is empty.
// - Cases with no right answer to heal towards (`not_healable`) get their
//   own refusals table, and cases that never reach the healer (`none`,
//   `silent`) are counted but kept out of every rate.
// - Gap cases are named, so a reader sees what Starfysh cannot do.
//
// The unit throughout is a case run: one case, run once, healed until it
// passes or the healer stops. A case run can contain several heals (a
// redesign needs more than one), so the per-heal figures are given
// separately under the supporting numbers.
//
// This module is pure: no file system, no browser. `report-cli.ts` reads
// the files and writes the output.

import type { UsageTotals } from '@sfysh/providers';
import type { RunAbort } from './abort.js';
import type { DriftGap } from './cases.js';
import type { CaseRunResult } from './heal-run.js';
import { FROZEN_SUITES, suiteByCasesHash, suiteByName } from './suites.js';
import type { FrozenSuite, SuiteRole } from './suites.js';

/** What `heal:drift` writes to results.json. */
export interface DriftResultsFile {
  suite: {
    /** The case set run (`heal:drift --cases`). Absent in results written before 2026-11-22, which are all v1. */
    caseSet?: string;
    /** The cases file whose hash is `casesSha256`. Absent before 2026-11-22, when it was always `cases.ts`. */
    casesFile?: string;
    cases: number;
    selected: number;
    casesSha256: string;
  };
  provider: string;
  model: string | null;
  prices: Record<string, { inputPerMTok: number; outputPerMTok: number }> | null;
  budget: unknown;
  runsPerCase: number;
  policy: string;
  judge: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  /** Present when `heal:drift` stopped early on a provider failure (see abort.ts). */
  aborted?: RunAbort;
  usage: UsageTotals;
  results: CaseRunResult[];
}

/** A proportion with its 95% Wilson score interval. */
export interface Rate {
  numerator: number;
  denominator: number;
  value: number;
  low: number;
  high: number;
}

/** One row of the heal quality table. */
export interface QualityRow {
  label: string;
  /** Distinct cases in the row. */
  cases: number;
  /** Case runs in the row. */
  runs: number;
  /** Runs where the healer was invoked (the first run did not pass clean). */
  attempted: number;
  /** Runs where at least one patch passed verification and was decided. */
  verified: number;
  /** Runs that ended healed and were judged correct. */
  correct: number;
  /** Runs where any decided heal was judged a false heal. */
  falseHeals: number;
  /** False heals over verified runs. Null when nothing was verified. */
  falseHealRate: Rate | null;
  /** Correct runs over all runs in the row. Null for an empty row. */
  healRate: Rate | null;
}

export interface RefusalsSection {
  /** `not_healable` case runs. */
  runs: number;
  /** Runs where the healer correctly decided no patch. */
  refused: number;
  /** Runs where a patch was decided anyway: false heals of the most serious kind. */
  wrongPatches: { caseId: string; run: number; verdict: string }[];
  /** Cases a person could fix but Starfysh cannot today, by name. */
  gaps: { caseId: string; gap: DriftGap; runs: number; refused: number }[];
  /** Cases with nothing left to heal towards (the feature is gone). */
  removed: { caseId: string; runs: number; refused: number }[];
}

export interface NeverReachedSection {
  /** Case runs expected never to reach the healer, by expected effect. */
  robust: { runs: number; reached: string[] };
  silent: { runs: number; reached: string[] };
}

export interface ScoreBand {
  label: string;
  correct: number;
  falseHeals: number;
}

export interface Percentiles {
  median: number;
  p90: number;
}

export interface SupportingNumbers {
  /** Correct runs over all healable runs: so "heal nothing" cannot win on false-heal rate alone. */
  healRate: Rate | null;
  /** Decided heals whose patch class matched the oracle's. */
  oracleAgreement: { agree: number; of: number };
  /** Heal-level counts: every decided heal, and how many were judged false. */
  perHeal: { decided: number; judged: number; falseHeals: number };
  /** Decided heals by confidence score band, against the judge's verdict. */
  scoreBands: ScoreBand[];
  cost: {
    calls: number;
    tokens: number;
    /** Null when any call had no price. */
    usd: number | null;
    /** Over case runs that called the model at least once. */
    runsWithModelCalls: number;
    tokensPerRun: Percentiles | null;
    usdPerRun: Percentiles | null;
    /** Total cost over correct runs. Null when unpriced or nothing was correct. */
    usdPerCorrectRun: number | null;
  };
  /** Failures routed by the `page_requires_field` text heuristic. */
  pageRequiresFieldHits: number;
}

export interface CaseLine {
  caseId: string;
  group: string;
  expected: string;
  trap: boolean;
  runs: number;
  correct: number;
  falseHeals: number;
  partial: number;
  notHealed: number;
}

export interface DriftReport {
  header: {
    suiteVersion: string | null;
    /** The frozen suite's role, when the results match it: `tuning` or `held_out`. */
    suiteRole: SuiteRole | null;
    cases: number;
    selected: number;
    /** The cases file the hash is of. */
    casesFile: string;
    casesSha256: string;
    provider: string;
    model: string | null;
    prices: DriftResultsFile['prices'];
    budget: unknown;
    runsPerCase: number;
    policy: string;
    judge: string;
    dryRun: boolean;
    startedAt: string;
    finishedAt: string | null;
  };
  /** Reasons the numbers are not fit to publish as they stand. Empty when they are. */
  warnings: string[];
  formula: string;
  quality: QualityRow[];
  refusals: RefusalsSection;
  neverReached: NeverReachedSection;
  supporting: SupportingNumbers;
  /** One line per healable case, in suite order. */
  perCase: CaseLine[];
  /** The one-sentence summary. Null when a warning rules a headline out. */
  headline: string | null;
}

export interface BuildReportOptions {
  /**
   * The frozen suite version these results were run on, for example
   * `drift-suite v1`. When left out, the suite is found from the
   * `cases.ts` hash in results.json.
   */
  suiteVersion?: string;
  /** The frozen suites to check against. Defaults to `FROZEN_SUITES`; tests pass their own. */
  suites?: readonly FrozenSuite[];
}

export const FALSE_HEAL_FORMULA =
  'False-heal rate = case runs with at least one false heal, divided by case runs with at least one verified, decided patch.';

const HEALABLE = new Set(['promotion', 'selector', 'insert_step']);
const isHealable = (r: CaseRunResult) => HEALABLE.has(r.expect.heal);

/** Score bands at the two thresholds the healer uses: low below 0.5, auto-accept from 0.8. */
const BANDS = [
  { label: 'below 0.5', test: (s: number) => s < 0.5 },
  { label: '0.5 to under 0.8', test: (s: number) => s >= 0.5 && s < 0.8 },
  { label: '0.8 and above', test: (s: number) => s >= 0.8 },
];

/**
 * The 95% Wilson score interval for `successes` out of `trials`. Null for
 * no trials. Used instead of the normal approximation because it stays
 * inside 0 to 1 and behaves at 0 and at small counts.
 */
export function wilson(successes: number, trials: number, z = 1.96): Rate | null {
  if (trials === 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return {
    numerator: successes,
    denominator: trials,
    value: p,
    low: Math.max(0, (centre - margin) / denominator),
    high: Math.min(1, (centre + margin) / denominator),
  };
}

/** Nearest-rank percentile of a non-empty list. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function percentiles(values: readonly number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { median: percentile(sorted, 50), p90: percentile(sorted, 90) };
}

const decided = (r: CaseRunResult) => r.heals.some((h) => h.decision !== undefined);
const isCorrect = (r: CaseRunResult) =>
  r.outcome === 'healed' && r.judgement?.verdict === 'correct';
// A false heal anywhere in the run counts, finished or not, as in the
// run summary.
const hasFalseHeal = (r: CaseRunResult) =>
  r.judgement?.verdict === 'false_heal' ||
  r.heals.some((h) => h.judgement?.verdict === 'false_heal');

function qualityRow(label: string, rows: readonly CaseRunResult[]): QualityRow {
  const verified = rows.filter(decided).length;
  const correct = rows.filter(isCorrect).length;
  const falseHeals = rows.filter(hasFalseHeal).length;
  return {
    label,
    cases: new Set(rows.map((r) => r.caseId)).size,
    runs: rows.length,
    attempted: rows.filter((r) => r.outcome !== 'not_invoked').length,
    verified,
    correct,
    falseHeals,
    falseHealRate: wilson(falseHeals, verified),
    healRate: wilson(correct, rows.length),
  };
}

/** Build the report. Pure: the same results always give the same report. */
export function buildReport(file: DriftResultsFile, options: BuildReportOptions = {}): DriftReport {
  const results = file.results;
  const healable = results.filter(isHealable);

  const quality = [
    qualityRow(
      'Single changes',
      healable.filter((r) => r.group === 'single'),
    ),
    qualityRow(
      'Complex changes',
      healable.filter((r) => r.group === 'complex'),
    ),
    qualityRow(
      'Decoy traps (also counted above)',
      healable.filter((r) => r.expect.trap === true),
    ),
    qualityRow('All healable', healable),
  ];

  // Refusals: the not_healable cases.
  const notHealable = results.filter((r) => r.expect.heal === 'not_healable');
  const byCase = groupByCase(notHealable);
  const refusals: RefusalsSection = {
    runs: notHealable.length,
    refused: notHealable.filter((r) => !decided(r)).length,
    wrongPatches: notHealable
      .filter(decided)
      .map((r) => ({ caseId: r.caseId, run: r.run, verdict: r.judgement?.verdict ?? 'unjudged' })),
    gaps: [...byCase]
      .filter(([, rows]) => rows[0]!.expect.gap !== undefined)
      .map(([caseId, rows]) => ({
        caseId,
        gap: rows[0]!.expect.gap!,
        runs: rows.length,
        refused: rows.filter((r) => !decided(r)).length,
      })),
    removed: [...byCase]
      .filter(([, rows]) => rows[0]!.expect.gap === undefined)
      .map(([caseId, rows]) => ({
        caseId,
        runs: rows.length,
        refused: rows.filter((r) => !decided(r)).length,
      })),
  };

  // Never meant to reach the healer.
  const reachedIds = (rows: CaseRunResult[]) =>
    rows.filter((r) => r.outcome !== 'not_invoked').map((r) => `${r.caseId} (run ${r.run})`);
  const robust = results.filter((r) => r.expect.heal === 'none' && r.expect.effect === 'none');
  const silent = results.filter((r) => r.expect.heal === 'none' && r.expect.effect === 'silent');
  const neverReached: NeverReachedSection = {
    robust: { runs: robust.length, reached: reachedIds(robust) },
    silent: { runs: silent.length, reached: reachedIds(silent) },
  };

  // Supporting numbers, at heal level where the question is about heals.
  const decidedHeals = results.flatMap((r) => r.heals.filter((h) => h.decision !== undefined));
  const withOracle = decidedHeals.filter((h) => h.oracleAgrees !== undefined);
  const judgedHeals = decidedHeals.filter((h) => h.judgement !== undefined);
  const scoreBands = BANDS.map(({ label, test }) => {
    const inBand = judgedHeals.filter((h) => h.score !== undefined && test(h.score));
    return {
      label,
      correct: inBand.filter((h) => h.judgement!.verdict === 'correct').length,
      falseHeals: inBand.filter((h) => h.judgement!.verdict === 'false_heal').length,
    };
  });

  const priced = file.usage.unpricedCalls === 0 && file.prices !== null;
  const modelRuns = results.filter((r) => r.usage.calls > 0);
  const correctRuns = healable.filter(isCorrect).length;
  const supporting: SupportingNumbers = {
    healRate: wilson(correctRuns, healable.length),
    oracleAgreement: {
      agree: withOracle.filter((h) => h.oracleAgrees).length,
      of: withOracle.length,
    },
    perHeal: {
      decided: decidedHeals.length,
      judged: judgedHeals.length,
      falseHeals: judgedHeals.filter((h) => h.judgement!.verdict === 'false_heal').length,
    },
    scoreBands,
    cost: {
      calls: file.usage.calls,
      tokens: file.usage.inputTokens + file.usage.outputTokens,
      usd: priced ? file.usage.costUsd : null,
      runsWithModelCalls: modelRuns.length,
      tokensPerRun: percentiles(modelRuns.map((r) => r.usage.inputTokens + r.usage.outputTokens)),
      usdPerRun: priced ? percentiles(modelRuns.map((r) => r.usage.costUsd)) : null,
      usdPerCorrectRun: priced && correctRuns > 0 ? file.usage.costUsd / correctRuns : null,
    },
    pageRequiresFieldHits: results
      .flatMap((r) => r.heals)
      .filter((h) => h.triage?.rule === 'page_requires_field').length,
  };

  const perCase = [...groupByCase(healable)].map(([caseId, rows]) => ({
    caseId,
    group: rows[0]!.group,
    expected: rows[0]!.expect.heal,
    trap: rows[0]!.expect.trap === true,
    runs: rows.length,
    correct: rows.filter(isCorrect).length,
    falseHeals: rows.filter(hasFalseHeal).length,
    partial: rows.filter((r) => r.outcome === 'partial' || r.outcome === 'max_heals').length,
    notHealed: rows.filter((r) => r.outcome === 'not_healed').length,
  }));

  const warnings: string[] = [];
  if (file.aborted !== undefined) {
    const a = file.aborted;
    warnings.push(
      `Stopped early: the provider failed on ${a.caseId} (run ${a.run}) with "${a.code}", so the run did not finish. These results are incomplete and must not be published.`,
    );
  }
  if (file.dryRun) {
    warnings.push(
      'Dry run with the oracle provider: these numbers measure the harness, not a model.',
    );
  }
  if (file.suite.selected < file.suite.cases) {
    warnings.push(
      `Partial suite: ${file.suite.selected} of ${file.suite.cases} cases were run. Group rates are not comparable with a full run.`,
    );
  }
  const suites = options.suites ?? FROZEN_SUITES;
  const casesFile = file.suite.casesFile ?? 'cases.ts';
  const suiteVersion =
    options.suiteVersion ?? suiteByCasesHash(file.suite.casesSha256, suites)?.name;
  const named = suiteVersion !== undefined ? suiteByName(suiteVersion, suites) : undefined;
  const matches = named !== undefined && named.casesSha256 === file.suite.casesSha256;
  if (suiteVersion === undefined) {
    warnings.push(
      `No suite version given, and the \`${casesFile}\` hash matches no frozen suite. A published number must name the frozen suite it was measured on.`,
    );
  } else if (named === undefined) {
    warnings.push(
      `"${suiteVersion}" is not a frozen suite (see \`drift/suites.ts\`). A published number must name the frozen suite it was measured on.`,
    );
  } else if (!matches) {
    warnings.push(
      `These results were not run on ${named.name}: their \`${casesFile}\` sha256 is ${file.suite.casesSha256}, the frozen suite's is ${named.casesSha256}.`,
    );
  } else if (named.role === 'tuning') {
    warnings.push(
      `${named.name} is the tuning set: the prompt was changed because of what these cases showed, so its rates are partly fitted to them. Report it beside the held-out headline, labelled as the tuning set, never as the headline.`,
    );
  }
  if (file.runsPerCase < 3) {
    warnings.push(
      `${file.runsPerCase} run(s) per case. Model answers vary between runs; publish with at least 3.`,
    );
  }
  if (!priced) warnings.push('Some model calls had no price, so cost figures are left out.');

  const header = {
    suiteVersion: suiteVersion ?? null,
    suiteRole: matches ? named.role : null,
    cases: file.suite.cases,
    selected: file.suite.selected,
    casesFile,
    casesSha256: file.suite.casesSha256,
    provider: file.provider,
    model: file.model,
    prices: file.prices,
    budget: file.budget,
    runsPerCase: file.runsPerCase,
    policy: file.policy,
    judge: file.judge,
    dryRun: file.dryRun,
    startedAt: file.startedAt,
    finishedAt: file.finishedAt ?? null,
  };

  return {
    header,
    warnings,
    formula: FALSE_HEAL_FORMULA,
    quality,
    refusals,
    neverReached,
    supporting,
    perCase,
    headline: warnings.length === 0 ? headlineOf(header, quality) : null,
  };
}

function headlineOf(header: DriftReport['header'], quality: QualityRow[]): string | null {
  const all = quality.find((q) => q.label === 'All healable')!;
  const traps = quality.find((q) => q.label.startsWith('Decoy traps'))!;
  if (all.healRate === null) return null;
  const falseRate =
    all.falseHealRate === null
      ? 'no verified heals to measure a false-heal rate on'
      : `a false-heal rate of ${pct(all.falseHealRate.value)} (95% CI ${pct(all.falseHealRate.low)} to ${pct(all.falseHealRate.high)})`;
  return (
    `On ${header.suiteVersion} (${all.cases} healable cases, ${header.runsPerCase} runs each, model ${header.model ?? header.provider}), ` +
    `Starfysh made a correct heal in ${pct(all.healRate.value)} of case runs, with ${falseRate}. ` +
    `On the ${traps.cases} decoy traps, which output checks alone cannot catch: ${traps.falseHeals} false heal(s) in ${traps.runs} run(s).`
  );
}

function groupByCase(rows: readonly CaseRunResult[]): Map<string, CaseRunResult[]> {
  const map = new Map<string, CaseRunResult[]>();
  for (const r of rows) {
    const list = map.get(r.caseId);
    if (list) list.push(r);
    else map.set(r.caseId, [r]);
  }
  return map;
}

function roleLabel(role: SuiteRole | null): string {
  if (role === 'tuning') return ' (tuning set)';
  if (role === 'held_out') return ' (held-out set)';
  return '';
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rateCell(rate: Rate | null): string {
  if (rate === null) return 'n/a';
  return `${pct(rate.value)} (${pct(rate.low)} to ${pct(rate.high)})`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Render the report as Markdown, for a repository page or a blog post draft. */
export function renderReport(report: DriftReport): string {
  const h = report.header;
  const out: string[] = [];
  const line = (text = '') => out.push(text);

  line('# Drift suite heal report');
  line();
  if (report.warnings.length > 0) {
    line('**Not for publication as it stands:**');
    line();
    for (const w of report.warnings) line(`- ${w}`);
    line();
  }

  line('## Run');
  line();
  line(
    `- Suite: ${h.suiteVersion ?? 'unversioned'}${roleLabel(h.suiteRole)}, ${h.selected} of ${h.cases} cases, \`${h.casesFile}\` sha256 \`${h.casesSha256}\``,
  );
  line(`- Model: ${h.provider}${h.model ? ` / ${h.model}` : ''}`);
  if (h.prices) {
    for (const [model, p] of Object.entries(h.prices)) {
      line(
        `- Prices: ${model} at $${p.inputPerMTok} input and $${p.outputPerMTok} output per million tokens`,
      );
    }
  }
  line(`- Budget: \`${JSON.stringify(h.budget)}\``);
  line(`- Runs per case: ${h.runsPerCase}`);
  line(`- Acceptance policy: ${h.policy}`);
  line(`- Judge: ${h.judge}`);
  line(`- Started ${h.startedAt}${h.finishedAt ? `, finished ${h.finishedAt}` : ''}`);
  line();
  line(
    `The unit is a case run: one case, run once, healed until it passes or the healer stops. ${report.formula} Intervals are 95% Wilson score intervals.`,
  );
  line();

  if (report.headline) {
    line('## Headline');
    line();
    line(report.headline);
    line();
    line('The headline is never shown without the tables below.');
    line();
  }

  line('## Heal quality (healable cases)');
  line();
  line(
    '| Group | Cases | Runs | Healer invoked | Verified | Correct | False heals | False-heal rate (95% CI) | Heal rate (95% CI) |',
  );
  line('|---|---:|---:|---:|---:|---:|---:|---|---|');
  for (const q of report.quality) {
    line(
      `| ${q.label} | ${q.cases} | ${q.runs} | ${q.attempted} | ${q.verified} | ${q.correct} | ${q.falseHeals} | ${rateCell(q.falseHealRate)} | ${rateCell(q.healRate)} |`,
    );
  }
  line();
  line(
    'Heal rate is correct runs over all runs in the row, so a healer that heals nothing cannot score well on false-heal rate alone.',
  );
  line();

  const r = report.refusals;
  line('## Refusals (cases that should not be healed)');
  line();
  line(
    `${r.refused} of ${r.runs} run(s) correctly produced no patch. A patch here would be a false heal of the most serious kind.`,
  );
  line();
  if (r.wrongPatches.length > 0) {
    line('Patches decided anyway:');
    line();
    for (const w of r.wrongPatches) line(`- ${w.caseId} (run ${w.run}): ${w.verdict}`);
    line();
  }
  if (r.gaps.length > 0) {
    line('Known gaps, which a person could fix and Starfysh cannot today:');
    line();
    line('| Case | Gap | Runs | Refused |');
    line('|---|---|---:|---:|');
    for (const g of r.gaps) line(`| ${g.caseId} | ${g.gap} | ${g.runs} | ${g.refused} |`);
    line();
  }
  if (r.removed.length > 0) {
    line('Removed features, with nothing left to heal towards:');
    line();
    line('| Case | Runs | Refused |');
    line('|---|---:|---:|');
    for (const g of r.removed) line(`| ${g.caseId} | ${g.runs} | ${g.refused} |`);
    line();
  }

  const n = report.neverReached;
  line('## Never meant to reach the healer');
  line();
  line('Counts only. These are excluded from every rate.');
  line();
  line(
    `- Changes the workflow survives: ${n.robust.runs} run(s), ${n.robust.reached.length} reached the healer${listOf(n.robust.reached)}`,
  );
  line(
    `- Silent breakage (passes with wrong outputs, so the healer is never told): ${n.silent.runs} run(s), ${n.silent.reached.length} reached the healer${listOf(n.silent.reached)}`,
  );
  line();

  const s = report.supporting;
  line('## Supporting numbers');
  line();
  line(
    `- Oracle agreement: ${s.oracleAgreement.agree} of ${s.oracleAgreement.of} decided heal(s) used the oracle's patch class.`,
  );
  line(
    `- Per heal: ${s.perHeal.decided} heal(s) decided, ${s.perHeal.judged} judged, ${s.perHeal.falseHeals} false.`,
  );
  line(`- \`page_requires_field\` heuristic: ${s.pageRequiresFieldHits} hit(s).`);
  const c = s.cost;
  line(
    `- Model use: ${c.calls} call(s), ${c.tokens} tokens${c.usd !== null ? `, ${usd(c.usd)} in total` : ''}.`,
  );
  if (c.tokensPerRun) {
    line(
      `- Per case run that called the model (${c.runsWithModelCalls}): median ${c.tokensPerRun.median} tokens, 90th percentile ${c.tokensPerRun.p90}${c.usdPerRun ? `; median ${usd(c.usdPerRun.median)}, 90th percentile ${usd(c.usdPerRun.p90)}` : ''}.`,
    );
  }
  if (c.usdPerCorrectRun !== null) line(`- Cost per correct heal: ${usd(c.usdPerCorrectRun)}.`);
  line();
  line('False heals by confidence score (decided heals; 0.8 is the auto-accept threshold):');
  line();
  line('| Score | Correct | False heals |');
  line('|---|---:|---:|');
  for (const b of s.scoreBands) line(`| ${b.label} | ${b.correct} | ${b.falseHeals} |`);
  line();

  line('## Per case');
  line();
  line('| Case | Group | Expected heal | Decoy | Runs | Correct | False | Partial | Not healed |');
  line('|---|---|---|---|---:|---:|---:|---:|---:|');
  for (const p of report.perCase) {
    line(
      `| ${p.caseId} | ${p.group} | ${p.expected} | ${p.trap ? 'yes' : ''} | ${p.runs} | ${p.correct} | ${p.falseHeals} | ${p.partial} | ${p.notHealed} |`,
    );
  }
  return `${out.join('\n')}\n`;
}

function listOf(items: readonly string[]): string {
  return items.length === 0 ? '.' : `: ${items.join(', ')}.`;
}
