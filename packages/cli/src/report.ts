// `compile label` and `compile report`.
//
// `compile label <heal id> --verdict false_heal --reviewer <name>` records
// whether a heal's change was right. A review says whether a person
// accepted a patch; a label says whether it was correct, which is what
// the false-heal rate counts (ADR 0004). It is usually written after the
// fact, when someone notices the data a healed workflow produced is wrong.
//
// `compile report` reads the corpus and prints the healer's record: what
// it did, the false-heal rate over labelled heals, how often the shadow
// rule agreed with people, and outcomes by confidence score.

import { join } from 'node:path';
import { corpusReport, JsonlCorpus, labelRecord, readCorpus, renderReport } from '@sfysh/healer';
import type { CorpusReport, LabelVerdict } from '@sfysh/healer';
import { DEFAULT_STATE_DIR, HealCommandError, isHealId } from './heal.js';

export const LABEL_VERDICTS: readonly LabelVerdict[] = ['correct', 'false_heal', 'unknown'];

export interface LabelCommandOptions {
  healId: string;
  verdict: LabelVerdict;
  reviewer: string;
  note?: string;
  /** State directory. Default `DEFAULT_STATE_DIR`. */
  stateDir?: string;
  now?: () => Date;
}

/**
 * Record a person's verdict on whether a heal was right. Refuses a heal id
 * that is not in the corpus, so a typo cannot create a label for nothing.
 */
export async function runLabelCommand(opts: LabelCommandOptions): Promise<{ output: string }> {
  if (!isHealId(opts.healId)) throw new HealCommandError(`'${opts.healId}' is not a heal id.`);
  if (!LABEL_VERDICTS.includes(opts.verdict)) {
    throw new HealCommandError(`--verdict must be one of ${LABEL_VERDICTS.join(', ')}.`);
  }
  if (opts.reviewer.trim() === '') throw new HealCommandError('a label must name the reviewer.');

  const dir = join(opts.stateDir ?? DEFAULT_STATE_DIR, 'corpus');
  const { records } = await readCorpus(dir);
  const heal = records.find((r) => r.kind === 'heal' && r.id === opts.healId);
  if (heal === undefined) {
    throw new HealCommandError(`no heal ${opts.healId} in the corpus at ${dir}.`);
  }

  await new JsonlCorpus({ dir }).write(
    labelRecord({
      heal: { id: heal.id, workflowId: heal.workflowId },
      verdict: opts.verdict,
      source: 'reviewer',
      reviewer: opts.reviewer,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      at: (opts.now ?? (() => new Date()))(),
    }),
  );
  return {
    output: `Labelled heal ${opts.healId} for workflow ${heal.workflowId} as ${opts.verdict.replace('_', ' ')}.`,
  };
}

export interface ReportCommandOptions {
  /** Only this workflow. */
  workflow?: string;
  format?: 'human' | 'json';
  stateDir?: string;
}

export interface ReportCommandResult {
  output: string;
  report: CorpusReport;
  /** Corpus lines that could not be read. */
  problems: number;
}

/** Summarise the corpus. An empty or missing corpus reports zeros, not an error. */
export async function runReportCommand(opts: ReportCommandOptions): Promise<ReportCommandResult> {
  const dir = join(opts.stateDir ?? DEFAULT_STATE_DIR, 'corpus');
  const { records, problems } = await readCorpus(dir);
  const report = corpusReport(records);
  let output: string;
  if (opts.format === 'json') {
    const body =
      opts.workflow === undefined
        ? { ...report, problems: problems.length }
        : { workflow: opts.workflow, summary: report.byWorkflow[opts.workflow] ?? null };
    output = JSON.stringify(body, null, 2);
  } else {
    output = renderReport(report, opts.workflow !== undefined ? { workflow: opts.workflow } : {});
    if (problems.length > 0) {
      output += `\n\n${problems.length} corpus lines could not be read and were skipped.`;
    }
  }
  return { output, report, problems: problems.length };
}
