// A plain-text summary of a drift heal run, printed at the end of
// `heal:drift`. Every figure carries its denominator. This is a working
// summary for the person running the suite; the published report (group
// split with intervals, refusals, oracle agreement, cost percentiles) is
// built separately from results.json and the corpus.

import type { UsageTotals } from '@sfysh/providers';
import type { CaseRunResult } from './heal-run.js';

const GROUPS = ['single', 'complex', 'robustness', 'silent'] as const;

export function renderSummary(results: readonly CaseRunResult[], usage: UsageTotals): string {
  const lines: string[] = [];
  const healable = (r: CaseRunResult) =>
    ['promotion', 'selector', 'insert_step'].includes(r.expect.heal);

  lines.push('Healable cases, by group (case runs):');
  lines.push('  group        runs  healed  correct  false  partial  not healed');
  for (const group of GROUPS) {
    const rows = results.filter((r) => r.group === group && healable(r));
    if (rows.length === 0) continue;
    const healed = rows.filter((r) => r.outcome === 'healed');
    const correct = healed.filter((r) => r.judgement?.verdict === 'correct').length;
    // A false heal anywhere in the run counts, finished or not.
    const falseHeals = rows.filter(
      (r) =>
        r.judgement?.verdict === 'false_heal' ||
        r.heals.some((h) => h.judgement?.verdict === 'false_heal'),
    ).length;
    const partial = rows.filter((r) => r.outcome === 'partial' || r.outcome === 'max_heals').length;
    const notHealed = rows.filter((r) => r.outcome === 'not_healed').length;
    lines.push(
      `  ${group.padEnd(11)} ${pad(rows.length, 5)} ${pad(healed.length, 7)} ${pad(correct, 8)} ${pad(falseHeals, 6)} ${pad(partial, 8)} ${pad(notHealed, 11)}`,
    );
  }
  const traps = results.filter((r) => r.expect.trap === true);
  if (traps.length > 0) {
    const caught = traps.filter((r) => r.judgement?.verdict === 'false_heal').length;
    lines.push(`  Decoy traps: ${caught} false heal(s) in ${traps.length} run(s).`);
  }

  const refusals = results.filter((r) => r.expect.heal === 'not_healable');
  if (refusals.length > 0) {
    const wrong = refusals.filter((r) => r.heals.some((h) => h.decision !== undefined));
    lines.push('');
    lines.push(
      `Not healable: ${refusals.length - wrong.length} of ${refusals.length} run(s) correctly produced no patch.`,
    );
    for (const r of wrong) {
      lines.push(
        `  ${r.caseId} (run ${r.run}): a patch was decided (${r.judgement?.verdict ?? 'unjudged'})`,
      );
    }
  }

  const never = results.filter((r) => r.expect.heal === 'none');
  const reached = never.filter((r) => r.outcome !== 'not_invoked');
  lines.push('');
  lines.push(
    `Never meant to reach the healer: ${never.length} run(s), ${reached.length} did (${reached.map((r) => r.caseId).join(', ') || 'none'}).`,
  );

  const triaged = results.flatMap((r) => r.heals.filter((h) => h.triage !== undefined));
  const fieldRule = triaged.filter((h) => h.triage?.rule === 'page_requires_field');
  lines.push(
    `Triage: ${triaged.length} failure(s) triaged, ${fieldRule.length} by the page_requires_field heuristic.`,
  );

  const decided = results.flatMap((r) => r.heals.filter((h) => h.decision !== undefined));
  const withOracle = decided.filter((h) => h.oracleAgrees !== undefined);
  lines.push(
    `Oracle agreement: ${withOracle.filter((h) => h.oracleAgrees).length} of ${withOracle.length} decided heal(s) used the oracle's patch class.`,
  );

  const modelHeals = decided.filter((h) => h.trigger === 'failure').length;
  const cost =
    usage.unpricedCalls > 0 ? 'cost unknown (no price given)' : `$${usage.costUsd.toFixed(4)}`;
  lines.push(
    `Model use: ${usage.calls} call(s), ${usage.inputTokens + usage.outputTokens} tokens, ${cost}, over ${modelHeals} decided model heal(s).`,
  );
  return lines.join('\n');
}

function pad(n: number, width: number): string {
  return String(n).padStart(width);
}
