// `compile heal`, `compile approve` and `compile reject`.
//
// `compile heal <file>` runs a workflow once against a live backend with
// the IR interpreter. A passing run is the healthy case: its outputs are
// saved as the workflow's known-good outputs, which every later patch is
// held to, and nothing else happens. A failing run goes to `heal()` with a
// history that persists between invocations, so the daily cap and the
// reversion check work for a command run once per failure. Every heal is
// written to the corpus. A verified patch is saved as pending, its review
// is printed, and a person answers with `compile approve <id>` or
// `compile reject <id>`.
//
// A run that passes only on fallback selectors is degraded. The command
// builds a promotion (move the candidate that worked to the front, no
// model), verifies it, and holds it for a person like any other patch.
// With `--auto-promote` a verified promotion is applied without a person;
// that is the only thing this command ever applies on its own. Every
// applied patch, approved or automatic, can be undone with
// `compile revert <id>`.
//
// State lives under one directory (default `.compile/`):
//
//   corpus/heals.jsonl        every heal and every review (`JsonlCorpus`)
//   heal-history.jsonl        heal runs and decided patches (`JsonlHealHistory`)
//   known-good/<id>.json      outputs of the last passing run, per workflow
//   pending/<heal id>.json    patches waiting for a person
//   applied/<heal id>.json    the workflow as it was before an applied patch, for revert
//
// Model-written patches always wait for a person. Automatic acceptance of
// those stays off until the benchmark shows the confidence score can be
// trusted.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  approvePatch,
  checkPatch,
  heal,
  healRecord,
  JsonlCorpus,
  JsonlHealHistory,
  printable,
  promote,
  promotionPatch,
  readCorpus,
  promotionRecord,
  renderReview,
  reviewRecord,
} from '@sfysh/healer';
import type {
  AcceptancePolicy,
  HealCorpusRecord,
  HealResult,
  HealVerifyOptions,
  KnownGood,
  PatchClass,
  PatchDecision,
} from '@sfysh/healer';
import { applyPatch, hashWorkflow, validateWorkflow } from '@sfysh/ir';
import type { Workflow } from '@sfysh/ir';
import {
  AnthropicProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAIProvider,
} from '@sfysh/providers';
import type { Provider, RedactFn } from '@sfysh/providers';
import { DEFAULT_SECRET_ENV_PREFIX, EnvVaultResolver } from '@sfysh/runtime';
import type { DegradedStep, VaultResolver } from '@sfysh/runtime';
import { createInterpreter, ENVELOPE_HISTORY_RUNS, replay } from '@sfysh/verifier';
import type { ReplayOutcome } from '@sfysh/verifier';
import { loadBackendModule, loadWorkflow } from './verify.js';
import type { LoadedBackend } from './verify.js';

/** Default state directory, relative to the working directory. */
export const DEFAULT_STATE_DIR = '.compile';

/** Providers `--provider` can name. Each reads its API key from its usual environment variable. */
export const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini', 'ollama'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** A problem the user can fix: bad arguments, a missing file, no known-good outputs. Exit code 1. */
export class HealCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HealCommandError';
  }
}

export interface HealCommandOptions {
  /** Workflow JSON file. */
  file: string;
  /** Backend module. Must export `pageFactory`; may export `provider`, `params`, `dispose`, `vaultResolver`, `tolerance`. */
  backend: string;
  /** A vendor provider by name. Takes precedence over the backend's `provider` export. */
  provider?: ProviderName;
  /** Model for `provider`. Default: the provider's own default. */
  model?: string;
  /** A JSON file of known-good outputs (an array, or `{ "outputs": [...] }`), used instead of the saved ones. */
  knownGood?: string;
  /** State directory. Default `DEFAULT_STATE_DIR`. */
  stateDir?: string;
  /** Live runs to verify a patch with. Default and minimum 3. */
  runs?: number;
  /** Longest one run may take, in milliseconds. */
  runTimeoutMs?: number;
  format?: 'human' | 'json';
  /**
   * Apply a verified promotion of a working fallback selector without a
   * person. Model-written patches still wait. Default false.
   */
  autoPromote?: boolean;
  /** Clock. Tests pass a fixed one. */
  now?: () => Date;
}

export type HealCommandStatus = 'passed' | HealResult['status'];

/** What became of a degraded pass. */
export type PromotionStatus =
  /** No degraded step could be promoted. */
  | 'none'
  /** The promotion did not verify, or the checks refused it. */
  | 'not_promoted'
  /** The promotion verified and waits for a person. */
  | 'pending'
  /** The promotion verified and was applied (`--auto-promote`). */
  | 'applied';

export interface HealCommandResult {
  status: HealCommandStatus;
  /** 0 nothing to heal, 2 not healed, 3 a patch waits for approval. */
  exitCode: 0 | 2 | 3;
  output: string;
  /** The corpus record, when a heal ran. */
  record?: HealCorpusRecord;
  /** Path of the pending patch, when one waits for approval. */
  pending?: string;
  /** Path the known-good outputs were saved to, when the run passed. */
  knownGoodSaved?: string;
  /** Steps that passed only on a fallback selector, when the run passed that way. */
  degraded?: DegradedStep[];
  /** For a degraded pass: what became of the promotion. */
  promotion?: PromotionStatus;
  /** Where the patched workflow was written, when a promotion was applied. */
  appliedTo?: string;
}

/** What `compile heal` and `compile approve` keep so an applied patch can be undone. */
export interface AppliedHeal {
  healId: string;
  /** Absolute path the patched workflow was written to. */
  workflowFile: string;
  workflowId: string;
  appliedAt: string;
  /** `policy` for an automatic promotion, otherwise the reviewer who approved. */
  appliedBy: string;
  /** The workflow exactly as it was before the patch. */
  before: Workflow;
  /** `hashWorkflow` of the patched workflow. Revert refuses if the file no longer has it. */
  afterHash: string;
}

/** What `compile heal` keeps for a patch until a person answers. */
export interface PendingHeal {
  healId: string;
  /** Absolute path of the workflow file the patch is for. */
  workflowFile: string;
  workflowId: string;
  patchClass: PatchClass;
  createdAt: string;
  decision: Extract<PatchDecision, { status: 'awaiting_approval' }>;
}

interface StatePaths {
  corpus: string;
  history: string;
  knownGood: (workflowId: string) => string;
  pending: (healId: string) => string;
  applied: (healId: string) => string;
  /** Exists once the `--auto-promote` risk notice has been shown. */
  autoPromoteAcknowledged: string;
}

function statePaths(stateDir: string = DEFAULT_STATE_DIR): StatePaths {
  return {
    corpus: join(stateDir, 'corpus'),
    history: join(stateDir, 'heal-history.jsonl'),
    // Workflow ids are lowercase letters, digits, `_` and `-` (IR schema),
    // so they are safe as file names.
    knownGood: (id) => join(stateDir, 'known-good', `${id}.json`),
    pending: (id) => join(stateDir, 'pending', `${id}.json`),
    applied: (id) => join(stateDir, 'applied', `${id}.json`),
    autoPromoteAcknowledged: join(stateDir, 'auto-promote-acknowledged'),
  };
}

/** Shown the first time `--auto-promote` is used with a state directory. */
export const AUTO_PROMOTE_NOTICE = [
  'Automatic promotion is on. What it does, and what it risks:',
  '  - When a step passes only on a fallback selector, that selector is moved to the front of the',
  '    step and the workflow file is rewritten, without asking you. No model is involved: the',
  '    selector was already in the workflow and has just worked on the live site.',
  '  - Before it is applied, the promoted workflow must pass at least three live runs using only',
  '    its new first selector, and reproduce the outputs of the run that just passed.',
  '  - Its outputs are also checked against what the last ten passing runs had in common (types,',
  '    lengths, ranges, the form of each value). A promotion whose outputs look different waits for',
  '    you as a possible false heal.',
  '  - Risk: the fallback can be a different element that gives outputs of the same kind and the',
  '    same values. Neither check catches that.',
  '  - A promotion that undoes an earlier heal still waits for you, as does every model-written patch.',
  '  - Every automatic promotion is recorded in the corpus and can be undone with',
  "    'compile revert <heal id> --reviewer <name>'.",
].join('\n');

/**
 * Run a workflow once and heal it if it fails. Throws `HealCommandError`
 * (or `VerifyLoadError` from `./verify.js` for the workflow and backend) for a problem the
 * user can fix. Anything the site, the model or the provider does comes
 * back as a result.
 */
export async function runHealCommand(opts: HealCommandOptions): Promise<HealCommandResult> {
  const now = opts.now ?? (() => new Date());
  const paths = statePaths(opts.stateDir);
  const workflow = loadWorkflow(opts.file);
  const backend = await loadBackendModule(opts.backend, { runner: 'optional' });
  const suppliedKnownGood =
    opts.knownGood !== undefined ? await readKnownGoodFile(opts.knownGood) : undefined;

  const vaultResolver: VaultResolver =
    backend.vaultResolver ??
    new EnvVaultResolver({ prefix: DEFAULT_SECRET_ENV_PREFIX, allow: workflow.secrets ?? [] });

  // The redaction of the most recent run, so everything sent to the model
  // and written to disk has that run's secrets stripped.
  let redact: RedactFn = (text) => text;
  const runOnce = async (): Promise<ReplayOutcome> => {
    const interpreter = createInterpreter(backend.params ? { params: backend.params } : {});
    const report = await replay(workflow, {
      pageFactory: backend.pageFactory,
      runs: 1,
      vaultResolver,
      runner: async (ctx, wf) => {
        redact = ctx.redact;
        await interpreter(ctx, wf);
      },
      ...(backend.dispose ? { dispose: backend.dispose } : {}),
      ...(opts.runTimeoutMs !== undefined ? { runTimeoutMs: opts.runTimeoutMs } : {}),
    });
    return report.replays[0]!;
  };

  const verify: HealVerifyOptions = {
    vaultResolver,
    ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
    ...(opts.runTimeoutMs !== undefined ? { runTimeoutMs: opts.runTimeoutMs } : {}),
    ...(backend.params ? { params: backend.params } : {}),
    ...(backend.dispose ? { dispose: backend.dispose } : {}),
    ...(backend.tolerance ? { tolerance: backend.tolerance } : {}),
  };

  const first = await runOnce();
  if (first.status === 'ok') {
    const saved = await saveKnownGood(paths, workflow, first.outputs, now());
    const degraded = first.degraded ?? [];
    if (degraded.length === 0) {
      return {
        status: 'passed',
        exitCode: 0,
        knownGoodSaved: saved,
        output: render(opts.format, { status: 'passed', knownGoodSaved: saved }, () =>
          [
            `Workflow ${workflow.id} passed. Nothing to heal.`,
            `Saved its outputs as known-good: ${saved}`,
          ].join('\n'),
        ),
      };
    }
    return promoteDegraded({
      opts,
      paths,
      workflow,
      degraded,
      // The run just saved, with the history it was added to.
      knownGood: (await loadKnownGood(paths, workflow.id)) ?? { outputs: first.outputs },
      knownGoodSaved: saved,
      backend,
      verify,
      redact,
      now,
    });
  }

  const knownGood = suppliedKnownGood ?? (await loadKnownGood(paths, workflow.id));
  if (knownGood === undefined) {
    throw new HealCommandError(
      `workflow ${workflow.id} failed, and there are no known-good outputs to hold a patch to. ` +
        `Run 'compile heal' once while the workflow passes, or pass --known-good <file>.`,
    );
  }

  // Only a failure needs a model. A passing or degraded run never calls one.
  if (opts.provider === undefined && backend.provider === undefined) {
    throw new HealCommandError(
      `workflow ${workflow.id} failed and there is no model provider to heal it. Pass --provider <${PROVIDER_NAMES.join('|')}>, or export 'provider' from the backend module.`,
    );
  }
  const provider =
    opts.provider !== undefined ? vendor(opts.provider, opts.model) : backend.provider!;
  const history = new JsonlHealHistory({ file: paths.history });
  await history.prune(now());

  const result = await heal({
    workflow,
    outcome: first,
    knownGood,
    provider,
    redact: (text) => redact(text),
    pageFactory: backend.pageFactory,
    history,
    retry: runOnce,
    now,
    verify,
  });

  const record = healRecord({ workflow, knownGood, result, redact, at: now() });
  const corpus = new JsonlCorpus({ dir: paths.corpus });
  await corpus.write(record);

  if (result.status === 'recovered') {
    const saved = await saveKnownGood(paths, workflow, result.triage.outcome.outputs, now());
    return {
      status: 'recovered',
      exitCode: 0,
      record,
      knownGoodSaved: saved,
      output: render(opts.format, { status: 'recovered', healId: record.id }, () =>
        [
          `Workflow ${workflow.id} failed once and passed on a retry. Nothing to heal.`,
          `Saved the retry's outputs as known-good: ${saved}`,
        ].join('\n'),
      ),
    };
  }

  if (result.status === 'decided') {
    if (result.decision.status !== 'awaiting_approval') {
      // The command never passes an automatic policy, so every verified
      // patch waits for a person.
      throw new Error(`unexpected decision '${result.decision.status}' under human approval`);
    }
    const pending: PendingHeal = {
      healId: record.id,
      workflowFile: resolvePath(opts.file),
      workflowId: workflow.id,
      patchClass: result.patchClass,
      createdAt: now().toISOString(),
      decision: result.decision,
    };
    const pendingPath = paths.pending(record.id);
    await mkdir(dirname(pendingPath), { recursive: true });
    await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
    return {
      status: 'decided',
      exitCode: 3,
      record,
      pending: pendingPath,
      output: render(
        opts.format,
        {
          status: 'decided',
          healId: record.id,
          pending: pendingPath,
          record: withoutShadow(record),
        },
        () =>
          [
            renderReview(result.decision, { workflow }),
            '',
            `Heal ${record.id} is waiting for approval.`,
            `  Approve: compile approve ${record.id} --reviewer <name>`,
            `  Reject:  compile reject ${record.id} --reviewer <name> [--note <text>]`,
          ].join('\n'),
      ),
    };
  }

  return {
    status: result.status,
    exitCode: 2,
    record,
    output: render(opts.format, { status: result.status, healId: record.id, record }, () =>
      notHealedText(workflow, result, record),
    ),
  };
}

interface PromoteDegradedInput {
  opts: HealCommandOptions;
  paths: StatePaths;
  workflow: Workflow;
  degraded: DegradedStep[];
  knownGood: KnownGood;
  knownGoodSaved: string;
  backend: LoadedBackend;
  verify: HealVerifyOptions;
  redact: RedactFn;
  now: () => Date;
}

/**
 * A run passed on fallback selectors. Build and verify a promotion of the
 * first degraded step, record it, and then hold it for a person, apply it
 * (`--auto-promote`), or report why it was not promoted. Never calls a
 * model.
 */
async function promoteDegraded(input: PromoteDegradedInput): Promise<HealCommandResult> {
  const { opts, paths, workflow, degraded, now } = input;
  // A person who reverted a change has said it was wrong. Auto mode never
  // makes that exact change again on its own; it waits for approval.
  const heldBecause = opts.autoPromote
    ? await revertedBefore(paths, workflow, degraded)
    : undefined;
  const policy: AcceptancePolicy =
    opts.autoPromote && heldBecause === undefined ? { mode: 'auto_promotion' } : { mode: 'human' };
  const notice = opts.autoPromote ? await firstAutoPromoteNotice(paths) : undefined;

  const history = new JsonlHealHistory({ file: paths.history });
  await history.prune(now());
  const result = await promote({
    workflow,
    degraded,
    knownGood: input.knownGood,
    pageFactory: input.backend.pageFactory,
    history,
    policy,
    now,
    verify: input.verify,
  });

  const header = [
    ...(notice !== undefined ? [notice, ''] : []),
    `Workflow ${workflow.id} passed, but only on fallback selectors.`,
    ...degraded.map(
      (d) =>
        `  Step ${d.stepId}: the primary selector failed; candidate #${d.candidateIndex + 1} (${d.selector.kind} ${JSON.stringify(printable(d.selector.value))}) worked.`,
    ),
    `Saved its outputs as known-good: ${input.knownGoodSaved}`,
  ];
  const base = {
    status: 'passed' as const,
    knownGoodSaved: input.knownGoodSaved,
    degraded,
  };

  if (result.status === 'none') {
    const reasons = result.skipped.map((s) => `  - ${s.stepId}: ${s.message}`);
    return {
      ...base,
      exitCode: 0,
      promotion: 'none',
      output: render(
        opts.format,
        { ...base, promotion: 'none', skipped: result.skipped, ...(notice ? { notice } : {}) },
        () => [...header, '', 'No promotion could be built:', ...reasons].join('\n'),
      ),
    };
  }

  const record = promotionRecord({
    workflow,
    knownGood: input.knownGood,
    policy,
    result,
    redact: input.redact,
    at: now(),
  });
  await new JsonlCorpus({ dir: paths.corpus }).write(record);
  const json = {
    ...base,
    healId: record.id,
    record,
    ...(notice ? { notice } : {}),
    ...(heldBecause ? { heldBecause } : {}),
  };

  if (result.status === 'not_promoted') {
    const verification = result.attempt.verification;
    const why =
      verification.status === 'failed'
        ? `it did not verify (${verification.failures.map((f) => f.code).join(', ')})`
        : verification.status === 'not_applied'
          ? 'it did not apply to the workflow'
          : 'the checks refused it';
    return {
      ...base,
      exitCode: 0,
      promotion: 'not_promoted',
      record,
      output: render(opts.format, { ...json, promotion: 'not_promoted' }, () =>
        [
          ...header,
          '',
          `A promotion of step ${result.attempt.degraded.stepId} was tried, but ${why}. The workflow keeps running on its fallback.`,
          `Recorded as heal ${record.id}.`,
        ].join('\n'),
      ),
    };
  }

  const remaining =
    result.remaining.length > 0
      ? [
          `Other degraded steps (${[...new Set(result.remaining.map((d) => d.stepId))].join(', ')}) can be promoted on the next run.`,
        ]
      : [];

  if (result.decision.status === 'accepted') {
    const target = resolvePath(opts.file);
    await applyPatchedWorkflow(paths, {
      healId: record.id,
      workflowFile: target,
      workflowId: workflow.id,
      appliedAt: now().toISOString(),
      appliedBy: 'policy',
      before: workflow,
      afterHash: result.decision.hash,
      after: result.decision.workflow,
    });
    return {
      ...base,
      exitCode: 0,
      promotion: 'applied',
      record,
      appliedTo: target,
      output: render(opts.format, { ...json, promotion: 'applied', appliedTo: target }, () =>
        [
          ...header,
          '',
          renderReview(result.decision, { workflow }),
          '',
          `Promoted automatically (--auto-promote) and wrote ${target}.`,
          `  Undo: compile revert ${record.id} --reviewer <name>`,
          ...remaining,
        ].join('\n'),
      ),
    };
  }

  const pendingPath = await savePending(paths, {
    healId: record.id,
    workflowFile: resolvePath(opts.file),
    workflowId: workflow.id,
    patchClass: 'promotion',
    createdAt: now().toISOString(),
    decision: result.decision,
  });
  return {
    ...base,
    exitCode: 3,
    promotion: 'pending',
    record,
    pending: pendingPath,
    output: render(opts.format, { ...json, promotion: 'pending', pending: pendingPath }, () =>
      [
        ...header,
        '',
        renderReview(result.decision, { workflow }),
        '',
        ...(heldBecause ? [`Not applied automatically: ${heldBecause}`] : []),
        `Heal ${record.id} (a promotion, no model) is waiting for approval.`,
        `  Approve: compile approve ${record.id} --reviewer <name>`,
        `  Reject:  compile reject ${record.id} --reviewer <name> [--note <text>]`,
        ...remaining,
      ].join('\n'),
    ),
  };
}

/**
 * Why the promotion this run would make must wait for a person, if a
 * person has already reverted a heal that produced exactly the same
 * workflow. Undefined when nothing was reverted, or nothing can be built.
 */
async function revertedBefore(
  paths: StatePaths,
  workflow: Workflow,
  degraded: readonly DegradedStep[],
): Promise<string | undefined> {
  const built = promotionPatch(workflow, degraded);
  if (built.status !== 'patch') return undefined;
  const applied = applyPatch(workflow, built.patch);
  if (!applied.ok) return undefined;

  const { records } = await readCorpus(paths.corpus);
  const reverted = new Set(
    records
      .filter((r) => r.kind === 'review' && r.verdict === 'reverted')
      .map((r) => (r.kind === 'review' ? r.healId : '')),
  );
  const earlier = records.find(
    (r) =>
      r.kind === 'heal' &&
      r.workflowId === workflow.id &&
      reverted.has(r.id) &&
      r.outcome.hash === applied.hash,
  );
  return earlier === undefined
    ? undefined
    : `a person reverted the same change before (heal ${earlier.id}).`;
}

/** The risk notice, the first time `--auto-promote` is used with this state directory; afterwards undefined. */
async function firstAutoPromoteNotice(paths: StatePaths): Promise<string | undefined> {
  if (existsSync(paths.autoPromoteAcknowledged)) return undefined;
  await mkdir(dirname(paths.autoPromoteAcknowledged), { recursive: true });
  await writeFile(paths.autoPromoteAcknowledged, `${new Date().toISOString()}\n`, 'utf8');
  return AUTO_PROMOTE_NOTICE;
}

async function savePending(paths: StatePaths, pending: PendingHeal): Promise<string> {
  const pendingPath = paths.pending(pending.healId);
  await mkdir(dirname(pendingPath), { recursive: true });
  await writeFile(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  return pendingPath;
}

/**
 * Keep the workflow as it was, then write the patched one. The backup is
 * written first, so a crash in between leaves an undo record and the old
 * file, never a changed file with no way back.
 */
async function applyPatchedWorkflow(
  paths: StatePaths,
  applied: AppliedHeal & { after: Workflow },
): Promise<void> {
  const { after, ...backup } = applied;
  const backupPath = paths.applied(applied.healId);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  await writeFile(applied.workflowFile, `${JSON.stringify(after, null, 2)}\n`, 'utf8');
}

export interface ReviewCommandOptions {
  /** Id of the heal, as `compile heal` printed it. */
  healId: string;
  reviewer: string;
  /** State directory. Default `DEFAULT_STATE_DIR`. */
  stateDir?: string;
  now?: () => Date;
}

export interface ApproveCommandOptions extends ReviewCommandOptions {
  /** Write the patched workflow here instead of over the original file. */
  out?: string;
}

export interface ReviewCommandResult {
  output: string;
  /** Where the patched workflow was written, for an approval. */
  wroteTo?: string;
}

/**
 * Approve a pending patch and write the patched workflow. The patch is
 * checked again against the workflow file as it is now, and refused if the
 * file changed since the heal or the patch breaks a rule: the pending file
 * sits on disk and is not trusted on its own.
 */
export async function runApproveCommand(opts: ApproveCommandOptions): Promise<ReviewCommandResult> {
  const now = opts.now ?? (() => new Date());
  const paths = statePaths(opts.stateDir);
  const pending = await loadPending(paths, opts.healId);
  const current = loadWorkflow(pending.workflowFile);

  // Staleness first, so a workflow edited since the heal is reported as
  // that, with the fix (heal again), rather than as a broken rule.
  const approved = approvePatch({
    decision: pending.decision,
    current,
    reviewer: opts.reviewer,
    at: now(),
  });
  if (approved.status === 'refused') {
    throw new HealCommandError(`heal ${opts.healId} cannot be approved: ${approved.message}`);
  }
  const verdict = checkPatch(pending.decision.patch, current, pending.patchClass);
  if (verdict.status === 'rejected') {
    throw new HealCommandError(
      `heal ${opts.healId} cannot be approved: the patch breaks a rule (${verdict.violations
        .map((v) => v.code)
        .join(', ')}).`,
    );
  }

  const target = resolvePath(opts.out ?? pending.workflowFile);
  await applyPatchedWorkflow(paths, {
    healId: pending.healId,
    workflowFile: target,
    workflowId: pending.workflowId,
    appliedAt: now().toISOString(),
    appliedBy: opts.reviewer.trim(),
    // The workflow as it stood before the patch: the original file,
    // whichever file the patched one is written to.
    before: current,
    afterHash: approved.decision.hash,
    after: approved.decision.workflow,
  });
  await new JsonlCorpus({ dir: paths.corpus }).write(
    reviewRecord({
      heal: { id: pending.healId, workflowId: pending.workflowId },
      verdict: 'approved',
      reviewer: opts.reviewer,
      at: now(),
    }),
  );
  await rm(paths.pending(opts.healId), { force: true });

  return {
    wroteTo: target,
    output: [
      `Approved heal ${opts.healId} for workflow ${pending.workflowId}.`,
      `Wrote the patched workflow to ${target}.`,
      `  Undo: compile revert ${opts.healId} --reviewer <name>`,
    ].join('\n'),
  };
}

export type RevertCommandOptions = ReviewCommandOptions & { note?: string };

/**
 * Undo an applied patch: write back the workflow as it was before. Refused
 * if the file has changed since the patch was applied (a later heal or a
 * hand edit), because restoring the old file would silently drop that
 * change. Records a `reverted` review in the corpus.
 */
export async function runRevertCommand(opts: RevertCommandOptions): Promise<ReviewCommandResult> {
  const now = opts.now ?? (() => new Date());
  const paths = statePaths(opts.stateDir);
  if (!HEAL_ID.test(opts.healId)) throw new HealCommandError(`'${opts.healId}' is not a heal id.`);
  if (opts.reviewer.trim() === '') throw new HealCommandError('a revert must name the reviewer.');

  let applied: AppliedHeal;
  try {
    applied = JSON.parse(await readFile(paths.applied(opts.healId), 'utf8')) as AppliedHeal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HealCommandError(
        `no applied heal ${opts.healId} to revert. It may never have been applied, or was already reverted.`,
      );
    }
    throw new HealCommandError(`applied heal ${opts.healId} could not be read.`);
  }
  if (
    applied === null ||
    typeof applied !== 'object' ||
    applied.healId !== opts.healId ||
    typeof applied.workflowFile !== 'string' ||
    typeof applied.afterHash !== 'string' ||
    typeof applied.before !== 'object'
  ) {
    throw new HealCommandError(`applied heal ${opts.healId} is malformed.`);
  }

  const current = loadWorkflow(applied.workflowFile);
  if (hashWorkflow(current) !== applied.afterHash) {
    throw new HealCommandError(
      `heal ${opts.healId} cannot be reverted: ${applied.workflowFile} has changed since the patch was applied. Undo the later changes first, or edit the file by hand.`,
    );
  }
  // The backup sits on disk; restore it only if it is still a valid workflow.
  const before = validatedWorkflow(applied.before);
  if (before === undefined) {
    throw new HealCommandError(
      `the saved workflow for heal ${opts.healId} is not a valid workflow.`,
    );
  }

  await writeFile(applied.workflowFile, `${JSON.stringify(before, null, 2)}\n`, 'utf8');
  await new JsonlCorpus({ dir: paths.corpus }).write(
    reviewRecord({
      heal: { id: opts.healId, workflowId: applied.workflowId },
      verdict: 'reverted',
      reviewer: opts.reviewer,
      at: now(),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    }),
  );
  await rm(paths.applied(opts.healId), { force: true });

  return {
    wroteTo: applied.workflowFile,
    output: [
      `Reverted heal ${opts.healId} for workflow ${applied.workflowId}.`,
      `Restored ${applied.workflowFile} to the workflow as it was before the patch.`,
    ].join('\n'),
  };
}

function validatedWorkflow(value: unknown): Workflow | undefined {
  const result = validateWorkflow(value);
  return result.valid && result.value ? result.value : undefined;
}

export interface RejectCommandOptions extends ReviewCommandOptions {
  note?: string;
}

/** Reject a pending patch. The workflow file is not touched. */
export async function runRejectCommand(opts: RejectCommandOptions): Promise<ReviewCommandResult> {
  const now = opts.now ?? (() => new Date());
  const paths = statePaths(opts.stateDir);
  const pending = await loadPending(paths, opts.healId);
  if (opts.reviewer.trim() === '')
    throw new HealCommandError('a rejection must name the reviewer.');

  await new JsonlCorpus({ dir: paths.corpus }).write(
    reviewRecord({
      heal: { id: pending.healId, workflowId: pending.workflowId },
      verdict: 'rejected',
      reviewer: opts.reviewer,
      at: now(),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    }),
  );
  await rm(paths.pending(opts.healId), { force: true });
  return { output: `Rejected heal ${opts.healId} for workflow ${pending.workflowId}.` };
}

function vendor(name: ProviderName, model: string | undefined): Provider {
  const config = model !== undefined ? { model } : {};
  switch (name) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
      return new OpenAIProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
  }
}

interface KnownGoodFile {
  workflowId: string;
  workflowHash: string;
  savedAt: string;
  /** The latest passing run's outputs: what a patch must reproduce. */
  outputs: unknown[];
  /**
   * The last `ENVELOPE_HISTORY_RUNS` passing runs, oldest first, the latest
   * included. What a patch's outputs must look like (ADR 0004). Absent in
   * files written before the history existed.
   */
  history?: { savedAt: string; outputs: unknown[] }[];
}

async function saveKnownGood(
  paths: StatePaths,
  workflow: Workflow,
  outputs: unknown[],
  at: Date,
): Promise<string> {
  const file = paths.knownGood(workflow.id);
  const previous = existsSync(file) ? await previousHistory(file, workflow.id) : [];
  const body: KnownGoodFile = {
    workflowId: workflow.id,
    workflowHash: hashWorkflow(workflow),
    savedAt: at.toISOString(),
    outputs,
    history: [...previous, { savedAt: at.toISOString(), outputs }].slice(-ENVELOPE_HISTORY_RUNS),
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * The history already on disk for this workflow. An unreadable file, or
 * one for another workflow, starts the history afresh rather than failing
 * a run that passed.
 */
async function previousHistory(
  file: string,
  workflowId: string,
): Promise<NonNullable<KnownGoodFile['history']>> {
  try {
    const body = JSON.parse(await readFile(file, 'utf8')) as Partial<KnownGoodFile>;
    if (body.workflowId !== workflowId) return [];
    if (Array.isArray(body.history)) {
      return body.history.filter((h) => typeof h?.savedAt === 'string' && Array.isArray(h.outputs));
    }
    return Array.isArray(body.outputs) && typeof body.savedAt === 'string'
      ? [{ savedAt: body.savedAt, outputs: body.outputs }]
      : [];
  } catch {
    return [];
  }
}

async function loadKnownGood(
  paths: StatePaths,
  workflowId: string,
): Promise<KnownGood | undefined> {
  const file = paths.knownGood(workflowId);
  if (!existsSync(file)) return undefined;
  return parseKnownGood(await readFile(file, 'utf8'), file);
}

async function readKnownGoodFile(file: string): Promise<KnownGood> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HealCommandError(`known-good file not found: ${file}`);
    }
    throw error;
  }
  return parseKnownGood(text, file);
}

function parseKnownGood(text: string, file: string): KnownGood {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HealCommandError(`known-good file '${file}' is not valid JSON.`);
  }
  const outputs = Array.isArray(value) ? value : (value as { outputs?: unknown } | null)?.outputs;
  if (!Array.isArray(outputs)) {
    throw new HealCommandError(
      `known-good file '${file}' must hold an array of outputs, or an object with an 'outputs' array.`,
    );
  }
  // A saved file carries its history; a hand-written one may too. Entries
  // that are not { outputs: [...] } are dropped rather than trusted.
  const rawHistory = Array.isArray(value)
    ? undefined
    : (value as { history?: unknown } | null)?.history;
  if (!Array.isArray(rawHistory)) return { outputs };
  const history = rawHistory
    .map((h) => (h as { outputs?: unknown } | null)?.outputs)
    .filter((o): o is unknown[] => Array.isArray(o));
  return { outputs, history };
}

// Heal ids are UUIDs. Checking the form keeps a crafted id from naming a
// file outside the pending directory.
const HEAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadPending(paths: StatePaths, healId: string): Promise<PendingHeal> {
  if (!HEAL_ID.test(healId)) throw new HealCommandError(`'${healId}' is not a heal id.`);
  let text: string;
  try {
    text = await readFile(paths.pending(healId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HealCommandError(`no pending heal ${healId}. It may already have been answered.`);
    }
    throw error;
  }
  let value: PendingHeal;
  try {
    value = JSON.parse(text) as PendingHeal;
  } catch {
    throw new HealCommandError(`pending heal ${healId} is not valid JSON.`);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    value.healId !== healId ||
    typeof value.workflowFile !== 'string' ||
    typeof value.workflowId !== 'string' ||
    !['selector', 'insert_step', 'promotion'].includes(value.patchClass) ||
    value.decision?.status !== 'awaiting_approval' ||
    typeof value.decision.patch !== 'object'
  ) {
    throw new HealCommandError(`pending heal ${healId} is malformed.`);
  }
  return value;
}

function render(
  format: 'human' | 'json' | undefined,
  json: Record<string, unknown>,
  human: () => string,
): string {
  return format === 'json' ? JSON.stringify(json, null, 2) : human();
}

function notHealedText(
  workflow: Workflow,
  result: Exclude<HealResult, { status: 'recovered' | 'decided' }>,
  record: HealCorpusRecord,
): string {
  const lines: string[] = [];
  const triage = result.triage.recovered ? undefined : result.triage.triage;
  const failure = record.failure;
  lines.push(
    `Workflow ${workflow.id} failed${failure?.stepId ? ` at step ${failure.stepId}` : ''}: ${printable(failure?.message ?? 'no error recorded')}`,
  );
  switch (result.status) {
    case 'routed':
      lines.push(
        `Triage sent this to '${result.route}', not to the healer (${triage?.kind}: ${printable(triage?.reason ?? '')}). No model was called.`,
      );
      break;
    case 'no_evidence':
      lines.push(
        result.reason === 'no_snapshot'
          ? 'The backend gave no page snapshot, so there is nothing to heal from. No model was called.'
          : 'The failure names no step, so there is nothing to heal. No model was called.',
      );
      break;
    case 'capped':
      lines.push(`Stopped by the '${result.cap}' limit.`);
      break;
    case 'not_healed':
      lines.push(
        result.reason === 'exhausted'
          ? 'No patch verified.'
          : 'The model provider failed in a way a retry will not fix.',
      );
      break;
  }
  for (const attempt of record.attempts) {
    const detail =
      attempt.verification?.status === 'failed'
        ? `verification failed (${(attempt.verification.failures ?? []).map((f) => f.code).join(', ')})`
        : attempt.status === 'rejected'
          ? `rejected at ${attempt.stage}: ${attempt.code}`
          : attempt.status === 'provider_error'
            ? `provider error ${attempt.code}: ${printable(attempt.message ?? '')}`
            : attempt.status === 'cannot_heal'
              ? `model could not heal: ${printable(attempt.rationale ?? '')}`
              : attempt.status;
    lines.push(`  - ${attempt.patchClass}: ${detail}`);
  }
  lines.push(`Recorded as heal ${record.id}.`);
  return lines.join('\n');
}

/**
 * The corpus record without its shadow verdicts, for output a reviewer may
 * read before deciding. Telling a reviewer the automatic rule would have
 * accepted a patch nudges them to accept it, which would spoil the
 * agreement data shadow mode collects. The corpus keeps the verdicts.
 */
function withoutShadow(record: HealCorpusRecord): HealCorpusRecord {
  return {
    ...record,
    attempts: record.attempts.map(({ wouldAutoAccept: _hidden, ...attempt }) => attempt),
  };
}
