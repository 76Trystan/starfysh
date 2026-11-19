// The healer on the drift suite: run each case the way a user's workflow
// would meet the change, let the healer (or, for a degraded run, the
// promotion path) fix it, and judge every fix against ground truth.
//
// One case run goes like this. Run the fixture's workflow on the drifted
// page. If it passes clean, the healer is never involved and the case is
// recorded as such. If it passes on a fallback selector, `promote()` builds
// and verifies a promotion, with no model. If it fails, `heal()` triages
// it and, for a site change, asks the model. A decided patch (accepted or
// waiting for a person) is applied, as if a reviewer approved it, and the
// workflow runs again, because some cases need several heals in a row.
// The loop stops when the workflow passes clean, when the healer gives
// up, or after `maxHeals`.
//
// Every heal is written to a corpus as the CLI writes it (`healRecord`,
// `promotionRecord`), followed by a `benchmark` label from the judge. The
// label judges that heal alone (`judgeProgress`): an early heal of a
// multi-heal case is correct if everything the patched workflow did
// before its next failure was right. The case as a whole is judged by
// `judgeHeal` on the final workflow, on two page loads so an A/B test or
// an intermittent banner shows both of its faces.

import type { Browser } from 'playwright-core';
import type { Workflow } from '@sfysh/ir';
import {
  heal,
  healRecord,
  labelRecord,
  MemoryHealHistory,
  promote,
  promotionRecord,
} from '@sfysh/healer';
import type {
  CorpusWriter,
  HealCorpusRecord,
  HealResult,
  HealVerifyOptions,
  KnownGood,
  ModelPatchClass,
  PatchClass,
} from '@sfysh/healer';
import { sumUsage } from '@sfysh/providers';
import type { MemoryUsageLedger, Provider, RedactFn, UsageTotals } from '@sfysh/providers';
import { createInterpreter, replay } from '@sfysh/verifier';
import type { ReplayOutcome } from '@sfysh/verifier';
import type { DriftCase } from './cases.js';
import {
  driftedPages,
  judgeHeal,
  judgeProgress,
  loadFixture,
  namesTruthMarker,
  observe,
} from './drift.js';
import type { DriftFixture, HealJudgement, Observation } from './drift.js';
import { classOf } from './oracle.js';

export interface DriftHealOptions {
  browser: Browser;
  /** The model. Wrap it in a `MeteredProvider` writing to `ledger` to get cost per case. */
  provider: Provider;
  /** The ledger `provider` records to. Per-case usage is read from the entries each case adds. */
  ledger?: MemoryUsageLedger;
  /** Where heal and label records go. */
  corpus: CorpusWriter;
  /** Most heals per case run. Default 4: the longest oracle has 3. */
  maxHeals?: number;
  /** Passed to every `heal()` and `promote()` verification. */
  verify?: HealVerifyOptions;
  /** Called before every heal or promotion, with the workflow about to be healed. The oracle provider uses it. */
  beforeHeal?: (input: { driftCase: DriftCase; workflow: Workflow; index: number }) => void;
  /** Clock for the corpus and the daily cap. */
  now?: () => Date;
}

/** One heal or promotion within a case run. */
export interface HealStepResult {
  /** Zero-based position within the case run. */
  index: number;
  trigger: 'failure' | 'degraded';
  /** The corpus record id. Absent when nothing was recorded (a promotion with nothing to build). */
  healId?: string;
  /** The step that failed or degraded. */
  stepId?: string;
  /** What `heal()` or `promote()` returned. */
  status: HealResult['status'] | 'not_promoted' | 'none';
  /** Triage's verdict, for a failure. */
  triage?: { kind: string; rule: string; route: string };
  /** Why `heal()` stopped without a patch: the reason, cap or route. */
  stopped?: string;
  /** Each model attempt: its class, what came back, and how verification went. */
  attempts: {
    patchClass: ModelPatchClass;
    generated: string;
    /** For a rejection: the stage (`input`, `response`, `candidates`, `policy`) and code. */
    rejection?: { stage: string; code: string };
    verification?: string;
    decision?: string;
  }[];
  /** The class of the patch that was decided. */
  patchClass?: PatchClass;
  score?: number;
  decision?: 'accepted' | 'awaiting_approval';
  reasons?: string[];
  /** The oracle's class at this position, and whether the decided class matches. */
  oracleClass?: PatchClass;
  oracleAgrees?: boolean;
  /** The judge's verdict on this heal. Present when a patch was decided. */
  judgement?: HealJudgement;
}

export type CaseOutcome =
  /** The run passed clean first time. The healer was never involved. */
  | 'not_invoked'
  /** Heals were decided and the final workflow passes clean. Read `judgement` for whether it is right. */
  | 'healed'
  /** At least one heal was decided, then the healer stopped while the workflow still fails or degrades. */
  | 'partial'
  /** No heal was decided. For a `not_healable` case this is the right answer. */
  | 'not_healed'
  /** `maxHeals` was reached with the workflow still failing or degrading. */
  | 'max_heals';

export interface CaseRunResult {
  caseId: string;
  fixture: DriftCase['fixture'];
  group: DriftCase['group'];
  expect: DriftCase['expect'];
  /** Which repetition of the case this is, from 1. */
  run: number;
  /** The first run on the drifted page. */
  initial: { status: ReplayOutcome['status']; failedStep?: string; degraded?: string[] };
  outcome: CaseOutcome;
  heals: HealStepResult[];
  /**
   * The final workflow judged against ground truth on two page loads.
   * Present for `healed`, and for `partial` and `max_heals` (where it is a
   * false heal unless the run passes).
   */
  judgement?: HealJudgement;
  usage: UsageTotals;
  durationMs: number;
}

/** Ground truth for each fixture: the original workflow on the clean page. */
export interface Baseline {
  fixture: DriftFixture;
  observation: Observation;
  knownGood: KnownGood;
}

/**
 * Observe a fixture's workflow on the clean page. Three runs, so the
 * known-good history has three entries, as a workflow that has passed a
 * few times in production would. Throws if the clean runs disagree.
 */
export async function loadBaseline(
  browser: Browser,
  name: DriftCase['fixture'],
): Promise<Baseline> {
  const fixture = loadFixture(name);
  const runs: Observation[] = [];
  for (let i = 0; i < 3; i++) runs.push(await observe(browser, fixture, []));
  const first = runs[0]!;
  if (runs.some((r) => r.status !== 'ok')) throw new Error(`the clean ${name} fixture failed`);
  const same = runs.every((r) => JSON.stringify(r.outputs) === JSON.stringify(first.outputs));
  if (!same) throw new Error(`the clean ${name} fixture gave different outputs on different runs`);
  return {
    fixture,
    observation: first,
    knownGood: { outputs: first.outputs, history: runs.map((r) => r.outputs) },
  };
}

/** Run one drift case once, healing until it passes or the healer stops. */
export async function runDriftCase(
  driftCase: DriftCase,
  baseline: Baseline,
  options: DriftHealOptions,
  run = 1,
): Promise<CaseRunResult> {
  const started = Date.now();
  const { browser, corpus } = options;
  const maxHeals = options.maxHeals ?? 4;
  const now = options.now ?? (() => new Date());
  const ledgerStart = options.ledger?.entries.length ?? 0;
  const { fixture } = baseline;
  const original = fixture.workflow;

  // One page source for the whole case run, so `on_loads` drifts keep
  // counting across the failing run, triage's retry and every verification.
  const pages = driftedPages(browser, fixture, driftCase.drifts);
  const history = new MemoryHealHistory();
  const verify: HealVerifyOptions = { dispose: pages.dispose, ...options.verify };

  let redact: RedactFn = (text) => text;
  const runOnce = async (workflow: Workflow): Promise<ReplayOutcome> => {
    const interpreter = createInterpreter({ candidates: 'fallthrough' });
    const report = await replay(workflow, {
      pageFactory: pages.pageFactory,
      runs: 1,
      runner: async (ctx, wf) => {
        redact = ctx.redact;
        await interpreter(ctx, wf);
      },
      dispose: pages.dispose,
    });
    return report.replays[0]!;
  };

  let workflow = original;
  let outcome = await runOnce(workflow);
  const initial: CaseRunResult['initial'] = {
    status: outcome.status,
    ...(outcome.error?.stepId !== undefined ? { failedStep: outcome.error.stepId } : {}),
    ...(outcome.degraded ? { degraded: outcome.degraded.map((d) => d.stepId) } : {}),
  };

  const heals: HealStepResult[] = [];
  let result: CaseOutcome | undefined;
  while (result === undefined) {
    const clean = outcome.status === 'ok' && (outcome.degraded ?? []).length === 0;
    if (clean) {
      result = heals.length === 0 ? 'not_invoked' : 'healed';
      break;
    }
    if (heals.length >= maxHeals) {
      result = 'max_heals';
      break;
    }

    const index = heals.length;
    options.beforeHeal?.({ driftCase, workflow, index });
    const step =
      outcome.status === 'ok'
        ? await promoteOnce(workflow, outcome)
        : await healOnce(workflow, outcome);
    heals.push(step.result);
    if (step.healed === undefined) {
      result = heals.some((h) => h.decision !== undefined) ? 'partial' : 'not_healed';
      break;
    }

    // Judge this heal on its own, then carry on from the patched workflow.
    const oracle = driftCase.oracle?.[index];
    if (oracle !== undefined && step.result.patchClass !== undefined) {
      step.result.oracleClass = classOf(oracle);
      step.result.oracleAgrees = step.result.patchClass === step.result.oracleClass;
    }
    const judgement = await judgeOnLoads(step.healed, judgeProgress);
    step.result.judgement = judgement;
    if (step.record !== undefined) {
      await corpus.write(
        labelRecord({
          heal: step.record,
          verdict: judgement.verdict,
          source: 'benchmark',
          note: labelNote(driftCase, run, index, judgement),
          at: now(),
        }),
      );
    }
    workflow = step.healed;
    outcome = await runOnce(workflow);
  }

  const judgement =
    result === 'healed' || result === 'partial' || result === 'max_heals'
      ? await judgeOnLoads(workflow, judgeHeal)
      : undefined;

  const entries = options.ledger?.entries.slice(ledgerStart) ?? [];
  return {
    caseId: driftCase.id,
    fixture: driftCase.fixture,
    group: driftCase.group,
    expect: driftCase.expect,
    run,
    initial,
    outcome: result,
    heals,
    ...(judgement !== undefined ? { judgement } : {}),
    usage: sumUsage(entries),
    durationMs: Date.now() - started,
  };

  /** Judge `healed` on page loads 1 and 2. Correct only if both are. */
  async function judgeOnLoads(
    healed: Workflow,
    judge: (baseline: Observation, patched: Observation) => HealJudgement,
  ): Promise<HealJudgement> {
    const reasons: string[] = [];
    if (namesTruthMarker(original, healed)) {
      reasons.push('it names the truth marker, which the healer cannot see, so it was invented');
    }
    for (const firstLoad of [1, 2]) {
      const seen = await observe(browser, fixture, driftCase.drifts, healed, { firstLoad });
      for (const reason of judge(baseline.observation, seen).reasons) {
        reasons.push(`load ${firstLoad}: ${reason}`);
      }
    }
    return { verdict: reasons.length === 0 ? 'correct' : 'false_heal', reasons };
  }

  async function promoteOnce(wf: Workflow, degradedRun: ReplayOutcome): Promise<StepOutcome> {
    const degraded = degradedRun.degraded ?? [];
    const promoted = await promote({
      workflow: wf,
      degraded,
      knownGood: baseline.knownGood,
      pageFactory: pages.pageFactory,
      history,
      verify,
      now,
    });
    const base: HealStepResult = {
      index: heals.length,
      trigger: 'degraded',
      stepId: degraded[0]?.stepId ?? '',
      status: promoted.status,
      attempts: [],
    };
    if (promoted.status === 'none') {
      return { result: { ...base, stopped: promoted.skipped.map((s) => s.reason).join(', ') } };
    }
    const record = promotionRecord({
      workflow: wf,
      knownGood: baseline.knownGood,
      result: promoted,
      redact,
      at: now(),
    });
    await corpus.write(record);
    const withRecord: HealStepResult = {
      ...base,
      healId: record.id,
      stepId: promoted.attempt.degraded.stepId,
      score: promoted.attempt.score.score,
    };
    if (promoted.status === 'not_promoted') {
      return {
        result: {
          ...withRecord,
          stopped: promoted.attempt.decision?.status ?? promoted.attempt.verification.status,
        },
        record,
      };
    }
    return {
      result: {
        ...withRecord,
        patchClass: 'promotion',
        decision: promoted.decision.status,
        ...(promoted.decision.status === 'awaiting_approval'
          ? { reasons: promoted.decision.reasons.map((r) => r.code) }
          : {}),
      },
      record,
      healed: promoted.decision.workflow,
    };
  }

  async function healOnce(wf: Workflow, failed: ReplayOutcome): Promise<StepOutcome> {
    const healed = await heal({
      workflow: wf,
      outcome: failed,
      knownGood: baseline.knownGood,
      provider: options.provider,
      redact: (text) => redact(text),
      pageFactory: pages.pageFactory,
      history,
      retry: () => runOnce(wf),
      verify,
      now,
    });
    const record = healRecord({
      workflow: wf,
      knownGood: baseline.knownGood,
      result: healed,
      redact,
      at: now(),
    });
    await corpus.write(record);

    // A recovered run keeps the triage of the failure it recovered from.
    const t = healed.triage;
    const seen = t.recovered ? t.firstTriage : t.triage;
    const step: HealStepResult = {
      index: heals.length,
      trigger: 'failure',
      healId: record.id,
      ...(failed.error?.stepId !== undefined ? { stepId: failed.error.stepId } : {}),
      status: healed.status,
      triage: {
        kind: seen.kind,
        rule: String(seen.rule),
        route: t.recovered ? 'recovered' : t.route,
      },
      attempts:
        'attempts' in healed
          ? healed.attempts.map((a) => ({
              patchClass: a.patchClass,
              generated: a.generated.status,
              ...(a.generated.status === 'rejected'
                ? { rejection: { stage: a.generated.stage, code: a.generated.code } }
                : a.generated.status === 'provider_error'
                  ? { rejection: { stage: 'provider', code: a.generated.code } }
                  : {}),
              ...(a.verification ? { verification: a.verification.status } : {}),
              ...(a.decision ? { decision: a.decision.status } : {}),
            }))
          : [],
    };

    if (healed.status !== 'decided') {
      const stopped =
        healed.status === 'routed'
          ? healed.route
          : healed.status === 'capped'
            ? healed.cap
            : healed.status === 'not_healed' || healed.status === 'no_evidence'
              ? healed.reason
              : 'recovered';
      return { result: { ...step, stopped }, record };
    }
    return {
      result: {
        ...step,
        patchClass: healed.patchClass,
        score: healed.decision.score.score,
        decision: healed.decision.status,
        ...(healed.decision.status === 'awaiting_approval'
          ? { reasons: healed.decision.reasons.map((r) => r.code) }
          : {}),
      },
      record,
      healed: healed.decision.workflow,
    };
  }
}

interface StepOutcome {
  result: HealStepResult;
  record?: HealCorpusRecord;
  /** The patched workflow, when a patch was decided. */
  healed?: Workflow;
}

function labelNote(driftCase: DriftCase, run: number, index: number, j: HealJudgement): string {
  const where = `drift case ${driftCase.id}, run ${run}, heal ${index + 1}`;
  return j.reasons.length === 0 ? where : `${where}: ${j.reasons.join('; ')}`;
}
