// `compile heal`, `compile approve` and `compile reject`.
//
// `compile heal <file>` runs a workflow once against a live backend with
// the IR interpreter. A passing run is the healthy case: its outputs are
// saved as the workflow's known-good outputs, which every later patch is
// held to, and nothing else happens. A failing run goes to `heal()` with a
// history that persists between invocations, so the daily cap and the
// reversion check work for a command run once per failure. Every heal is
// written to the corpus. A patch is never applied here: a verified patch
// is saved as pending, its review is printed, and a person answers with
// `compile approve <id>` or `compile reject <id>`.
//
// State lives under one directory (default `.compile/`):
//
//   corpus/heals.jsonl        every heal and every review (`JsonlCorpus`)
//   heal-history.jsonl        heal runs and decided patches (`JsonlHealHistory`)
//   known-good/<id>.json      outputs of the last passing run, per workflow
//   pending/<heal id>.json    patches waiting for a person
//
// The policy is always human approval. Automatic acceptance stays off
// until the benchmark shows the confidence score can be trusted.

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
  renderReview,
  reviewRecord,
} from '@sfysh/healer';
import type {
  HealCorpusRecord,
  HealResult,
  KnownGood,
  PatchClass,
  PatchDecision,
} from '@sfysh/healer';
import { hashWorkflow } from '@sfysh/ir';
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
import { createInterpreter, replay } from '@sfysh/verifier';
import type { ReplayOutcome } from '@sfysh/verifier';
import { loadBackendModule, loadWorkflow } from './verify.js';

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
  /** Clock. Tests pass a fixed one. */
  now?: () => Date;
}

export type HealCommandStatus = 'passed' | HealResult['status'];

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
}

function statePaths(stateDir: string = DEFAULT_STATE_DIR): StatePaths {
  return {
    corpus: join(stateDir, 'corpus'),
    history: join(stateDir, 'heal-history.jsonl'),
    // Workflow ids are lowercase letters, digits, `_` and `-` (IR schema),
    // so they are safe as file names.
    knownGood: (id) => join(stateDir, 'known-good', `${id}.json`),
    pending: (id) => join(stateDir, 'pending', `${id}.json`),
  };
}

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
  if (opts.provider === undefined && backend.provider === undefined) {
    throw new HealCommandError(
      `no model provider. Pass --provider <${PROVIDER_NAMES.join('|')}>, or export 'provider' from the backend module.`,
    );
  }
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

  const first = await runOnce();
  if (first.status === 'ok') {
    const saved = await saveKnownGood(paths, workflow, first.outputs, now());
    const degraded = first.degraded ?? [];
    const extra = degraded.length > 0 ? { degraded } : {};
    return {
      status: 'passed',
      exitCode: 0,
      knownGoodSaved: saved,
      ...extra,
      output: render(opts.format, { status: 'passed', knownGoodSaved: saved, ...extra }, () =>
        [
          degraded.length > 0
            ? `Workflow ${workflow.id} passed, but only on fallback selectors.`
            : `Workflow ${workflow.id} passed. Nothing to heal.`,
          ...degraded.map(
            (d) =>
              `  Step ${d.stepId}: the primary selector failed; candidate #${d.candidateIndex + 1} (${d.selector.kind} ${JSON.stringify(printable(d.selector.value))}) worked.`,
          ),
          ...(degraded.length > 0
            ? [
                '  The next change to these elements may break the workflow. Consider promoting the working candidates.',
              ]
            : []),
          `Saved its outputs as known-good: ${saved}`,
        ].join('\n'),
      ),
    };
  }

  const knownGood = suppliedKnownGood ?? (await loadKnownGood(paths, workflow.id));
  if (knownGood === undefined) {
    throw new HealCommandError(
      `workflow ${workflow.id} failed, and there are no known-good outputs to hold a patch to. ` +
        `Run 'compile heal' once while the workflow passes, or pass --known-good <file>.`,
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
    verify: {
      vaultResolver,
      ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
      ...(opts.runTimeoutMs !== undefined ? { runTimeoutMs: opts.runTimeoutMs } : {}),
      ...(backend.params ? { params: backend.params } : {}),
      ...(backend.dispose ? { dispose: backend.dispose } : {}),
      ...(backend.tolerance ? { tolerance: backend.tolerance } : {}),
    },
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
        { status: 'decided', healId: record.id, pending: pendingPath, record },
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

  const target = opts.out ?? pending.workflowFile;
  await writeFile(target, `${JSON.stringify(approved.decision.workflow, null, 2)}\n`, 'utf8');
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
    ].join('\n'),
  };
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
  outputs: unknown[];
}

async function saveKnownGood(
  paths: StatePaths,
  workflow: Workflow,
  outputs: unknown[],
  at: Date,
): Promise<string> {
  const file = paths.knownGood(workflow.id);
  const body: KnownGoodFile = {
    workflowId: workflow.id,
    workflowHash: hashWorkflow(workflow),
    savedAt: at.toISOString(),
    outputs,
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
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
  return { outputs };
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
    (value.patchClass !== 'selector' && value.patchClass !== 'insert_step') ||
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
