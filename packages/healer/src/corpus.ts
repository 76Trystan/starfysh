// The heal corpus: one record per heal, kept on disk as JSON Lines.
//
// Every heal is written down whatever its outcome, so that three questions
// can be answered later from the record alone:
//
// - Audit. What failed, what the model was shown (by hash), which model
//   answered, what it proposed, how verification went, and who approved.
// - Calibration. The confidence score and its signals sit next to the
//   verification result and the reviewer's verdict, which is what the
//   benchmark needs to check that false heals cluster at low scores
//   before any threshold is trusted to skip review.
// - Training data, later. The patches and their verdicts are the raw
//   material for a repair model.
//
// What is never written: secret values, the page snapshot, and (unless
// the caller opts in) the workflow's outputs. The snapshot and outputs are
// page content; the record carries their SHA-256 instead, which is enough
// to tell whether two heals saw the same page or produced the same data.
// Every string value in a record is passed through the caller's `redact`
// before it is written, as a backstop for anything the IR rules missed.
//
// A review is a separate record pointing at the heal by id, because the
// person may answer hours after the heal ran and the file is append-only.

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashWorkflow } from '@sfysh/ir';
import type { SelectorCandidate, StepPatch, Workflow } from '@sfysh/ir';
import type { RedactFn, TokenUsage } from '@sfysh/providers';
import type { ReplayOutcome } from '@sfysh/verifier';
import type {
  AcceptancePolicy,
  ApprovalReasonCode,
  KnownGood,
  PatchDecision,
  PatchVerification,
  VerificationFailureCode,
} from './accept.js';
import type { PatchClass } from './allowlist.js';
import { canonical } from './equal.js';
import type { HealAttempt, HealCap, HealResult } from './heal.js';
import type { PromoteResult } from './promote.js';
import { PROMPT_ERROR_MAX_CHARS } from './prompt.js';
import type { ReachApproval } from './reach.js';
import type { ReversionCode } from './revert.js';
import type { ShadowDecision } from './shadow.js';
import type { PatchScore } from './score.js';
import type { HealerTriage, HealRoute } from './triage.js';

/** Format version of every record. Bumped when a reader would misread an older record. */
export const CORPUS_VERSION = 1;

/** Where `JsonlCorpus` keeps the corpus when no directory is given, relative to the working directory. */
export const DEFAULT_CORPUS_DIR = '.compile/corpus';

/** The file inside the corpus directory. */
export const CORPUS_FILE = 'heals.jsonl';

/** Longest free-text value kept in a record (model rationale, provider message). */
export const CORPUS_TEXT_MAX_CHARS = 2_000;

/** The failure the heal started from. */
export interface CorpusFailure {
  name: string;
  /** Redacted, and cut to `PROMPT_ERROR_MAX_CHARS`. */
  message: string;
  stepId?: string;
  action?: string;
  selector?: SelectorCandidate;
  phase?: 'pre' | 'post';
  reason?: string;
}

/** How triage classified the failure. */
export interface CorpusTriage {
  kind: HealerTriage['kind'];
  rule: HealerTriage['rule'];
  /** Absent when the retry passed. */
  route?: HealRoute;
  retried: boolean;
  recovered: boolean;
  /** Classification of the first failure, when a retry ran. */
  firstKind?: HealerTriage['kind'];
}

/** What verification found, without the outputs themselves. */
export interface CorpusVerification {
  status: PatchVerification['status'];
  /** Present when the patched workflow ran. */
  runs?: number;
  passed?: number;
  /** Duration of each run, in milliseconds. */
  durationsMs?: number[];
  /** `sha256:` of each run's outputs, in run order. Equal hashes mean equal outputs. */
  outputHashes?: string[];
  failures?: { code: VerificationFailureCode; run?: number; paths?: string[] }[];
  /** `hashWorkflow` of the patched workflow, when it verified. */
  hash?: string;
  stepRan?: 'confirmed' | 'unchecked';
  /** For `not_applied`: the validation errors' messages. */
  errors?: string[];
  /**
   * The known-good history check (ADR 0004): status, history size, and for
   * `outside` the fields and checks that deviated. Never values.
   */
  envelope?: {
    status: 'within' | 'outside' | 'insufficient_history';
    runs: number;
    deviations?: { path: string; check: string }[];
  };
}

/** What `decidePatch` made of a verified patch. */
export interface CorpusDecision {
  status: PatchDecision['status'];
  /** Why a person is needed. Present for `awaiting_approval`. */
  reasons?: ApprovalReasonCode[];
  /** Codes of the broken rules, for a decision rejected on the checks. */
  violations?: string[];
  /** For `accepted`: by policy, or by a named reviewer. */
  acceptedBy?: Extract<PatchDecision, { status: 'accepted' }>['acceptedBy'];
}

/** One model call and what became of its answer. */
export interface CorpusAttempt {
  patchClass: PatchClass;
  /** The generator's result status. */
  status: HealAttempt['generated']['status'];
  /** For a rejection: where it was refused. */
  stage?: 'input' | 'response' | 'candidates' | 'policy';
  /** For a rejection or provider error. */
  code?: string;
  /** For a rejection or provider error. Redacted and cut. */
  message?: string;
  /** For a provider error. */
  retryable?: boolean;
  /** For `cannot_heal`: the model's explanation. Untrusted, redacted and cut. */
  rationale?: string;
  /** Present when the call got an answer. */
  model?: string;
  promptHash?: string;
  usage?: TokenUsage;
  /** The patch, scored. Present for `patch` and `needs_approval`. */
  patch?: StepPatch;
  score?: PatchScore;
  /** Points the checks asked a person to confirm. */
  approvals?: ReachApproval[];
  /** Codes of the rules a `policy` rejection broke. */
  violations?: string[];
  verification?: CorpusVerification;
  decision?: CorpusDecision;
  /** Earlier heals this patch undoes. */
  reversions?: { code: ReversionCode; at: string }[];
  /**
   * Shadow mode: whether the candidate automatic rule would have accepted
   * this patch without a person. Compared with the reviewer's verdict in
   * a later `review` record to measure how often the rule agrees with
   * people. Present on verified model-written patches.
   */
  wouldAutoAccept?: ShadowDecision;
}

/** The final result of one `heal()`. */
export interface CorpusOutcome {
  status: HealResult['status'];
  route?: Exclude<HealRoute, 'heal'>;
  reason?: 'no_snapshot' | 'no_step' | 'exhausted' | 'provider_error';
  cap?: HealCap;
  /** For `decided`. */
  patchClass?: PatchClass;
  decision?: 'accepted' | 'awaiting_approval';
  /** For `decided`: `hashWorkflow` of the patched workflow. */
  hash?: string;
}

/** One `heal()` run. */
export interface HealCorpusRecord {
  corpusVersion: typeof CORPUS_VERSION;
  kind: 'heal';
  /** Random id. Review records point at it. */
  id: string;
  /** When the record was made, ISO 8601. */
  at: string;
  workflowId: string;
  /** `hashWorkflow` of the workflow that failed. */
  workflowHash: string;
  irVersion: string;
  /**
   * What started the heal. `failure` (or absent, in records written before
   * promotions existed): a failed run, through triage. `degraded`: a run
   * that passed on a fallback candidate, promoted without a model.
   */
  trigger?: 'failure' | 'degraded';
  /** For a `degraded` trigger: the step and the candidate that worked. */
  degraded?: { stepId: string; candidateIndex: number; selector: SelectorCandidate };
  failure?: CorpusFailure;
  /** How triage classified the failure. Absent for a promotion, which has no failure. */
  triage?: CorpusTriage;
  /** `sha256:` of the page snapshot the heal worked from. The snapshot itself is never written. */
  snapshotHash?: string;
  /** Whether that snapshot was cut to fit the capture cap. */
  snapshotTruncated?: boolean;
  /** `sha256:` of the known-good outputs every patch was held to. */
  knownGoodHash: string;
  /** The known-good outputs themselves, redacted. Only with `includeOutputs`. */
  knownGoodOutputs?: unknown[];
  /** The acceptance policy the heal ran under. */
  policy: AcceptancePolicy;
  attempts: CorpusAttempt[];
  outcome: CorpusOutcome;
  /** Tokens across every model call in the heal. */
  usage: TokenUsage;
}

/** A person's answer to a heal that was held for review. */
export interface ReviewCorpusRecord {
  corpusVersion: typeof CORPUS_VERSION;
  kind: 'review';
  id: string;
  at: string;
  /** The heal record this answers. */
  healId: string;
  workflowId: string;
  /**
   * `approved` and `rejected` answer a held heal. `reverted` undoes a heal
   * that was applied, by a person or by policy.
   */
  verdict: 'approved' | 'rejected' | 'reverted';
  reviewer: string;
  /** Free text from the reviewer, redacted and cut. */
  note?: string;
}

export type CorpusRecord = HealCorpusRecord | ReviewCorpusRecord;

export interface HealRecordInput {
  /** The workflow passed to `heal()`. */
  workflow: Workflow;
  /** The known-good outputs passed to `heal()`. */
  knownGood: KnownGood;
  /** The policy passed to `heal()`. Default `{ mode: 'human' }`, as in `heal()`. */
  policy?: AcceptancePolicy;
  /** What `heal()` returned. */
  result: HealResult;
  /** The redaction used for the heal. Applied to every string in the record. */
  redact: RedactFn;
  /**
   * Keep the known-good outputs in the record, redacted. Default false:
   * outputs are page content, and the hash is enough to compare heals.
   */
  includeOutputs?: boolean;
  /** Default now. */
  at?: Date;
  /** Default a random UUID. Tests pass a fixed one. */
  id?: string;
}

/**
 * Build the corpus record for one `heal()`. Pure apart from the default
 * id and clock: it writes nothing. Pass the result to a `CorpusWriter`.
 */
export function healRecord(input: HealRecordInput): HealCorpusRecord {
  const { workflow, result } = input;
  const triage = result.triage;
  const outcome: ReplayOutcome = triage.outcome;

  const record: HealCorpusRecord = {
    corpusVersion: CORPUS_VERSION,
    kind: 'heal',
    id: input.id ?? randomUUID(),
    at: (input.at ?? new Date()).toISOString(),
    workflowId: workflow.id,
    workflowHash: hashWorkflow(workflow),
    irVersion: workflow.irVersion,
    trigger: 'failure',
    triage: corpusTriage(result),
    knownGoodHash: canonical(input.knownGood.outputs),
    policy: input.policy ?? { mode: 'human' },
    attempts: 'attempts' in result ? result.attempts.map(corpusAttempt) : [],
    outcome: corpusOutcome(result),
    usage: 'usage' in result ? { ...result.usage } : { inputTokens: 0, outputTokens: 0 },
  };

  // A recovered heal describes the passing retry; the failure worth
  // recording is the one that triage saw first, which is not kept. Only a
  // routed heal has the failure it was routed on.
  if (!triage.recovered && outcome.error !== undefined) {
    record.failure = corpusFailure(outcome.error);
  }
  if (!triage.recovered && outcome.snapshot !== undefined) {
    record.snapshotHash = canonical(outcome.snapshot.text);
    record.snapshotTruncated = outcome.snapshot.truncated;
  }
  if (input.includeOutputs === true) {
    record.knownGoodOutputs = structuredClone(input.knownGood.outputs);
  }

  return redactDeep(record, input.redact);
}

export interface PromotionRecordInput {
  /** The workflow passed to `promote()`. */
  workflow: Workflow;
  /** The known-good outputs passed to `promote()`. */
  knownGood: KnownGood;
  /** The policy passed to `promote()`. Default `{ mode: 'human' }`. */
  policy?: AcceptancePolicy;
  /** What `promote()` returned, other than `none`, which has nothing to record. */
  result: Exclude<PromoteResult, { status: 'none' }>;
  redact: RedactFn;
  includeOutputs?: boolean;
  at?: Date;
  id?: string;
}

/**
 * Build the corpus record for one promotion. Same record kind as a heal,
 * with `trigger: 'degraded'`, no triage or failure, one attempt of class
 * `promotion`, and no tokens.
 */
export function promotionRecord(input: PromotionRecordInput): HealCorpusRecord {
  const { workflow, result } = input;
  const { attempt } = result;

  const corpusAttemptOut: CorpusAttempt = {
    patchClass: 'promotion',
    status: 'patch',
    patch: structuredClone(attempt.patch),
    score: structuredClone(attempt.score),
    verification: corpusVerification(attempt.verification),
  };
  if (attempt.decision !== undefined) corpusAttemptOut.decision = corpusDecision(attempt.decision);
  if (attempt.reversions !== undefined) {
    corpusAttemptOut.reversions = attempt.reversions.map((r) => ({
      code: r.code,
      at: r.at.toISOString(),
    }));
  }

  const record: HealCorpusRecord = {
    corpusVersion: CORPUS_VERSION,
    kind: 'heal',
    id: input.id ?? randomUUID(),
    at: (input.at ?? new Date()).toISOString(),
    workflowId: workflow.id,
    workflowHash: hashWorkflow(workflow),
    irVersion: workflow.irVersion,
    trigger: 'degraded',
    degraded: {
      stepId: attempt.degraded.stepId,
      candidateIndex: attempt.degraded.candidateIndex,
      selector: { ...attempt.degraded.selector },
    },
    knownGoodHash: canonical(input.knownGood.outputs),
    policy: input.policy ?? { mode: 'human' },
    attempts: [corpusAttemptOut],
    outcome:
      result.status === 'decided'
        ? {
            status: 'decided',
            patchClass: 'promotion',
            decision: result.decision.status,
            hash: result.decision.hash,
          }
        : { status: 'not_healed', reason: 'exhausted' },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  if (input.includeOutputs === true) {
    record.knownGoodOutputs = structuredClone(input.knownGood.outputs);
  }
  return redactDeep(record, input.redact);
}

export interface ReviewRecordInput {
  /** The heal record being answered. */
  heal: Pick<HealCorpusRecord, 'id' | 'workflowId'>;
  verdict: 'approved' | 'rejected' | 'reverted';
  /** Who answered. Must not be blank. */
  reviewer: string;
  note?: string;
  /** Applied to the reviewer and the note. Default: none. */
  redact?: RedactFn;
  /** Default now. */
  at?: Date;
  /** Default a random UUID. */
  id?: string;
}

/**
 * Build the record of a person's verdict on a held heal. Throws
 * `TypeError` for a blank reviewer: an anonymous verdict is no audit.
 */
export function reviewRecord(input: ReviewRecordInput): ReviewCorpusRecord {
  const reviewer = input.reviewer.trim();
  if (reviewer === '') throw new TypeError('A review record must name the reviewer.');
  const record: ReviewCorpusRecord = {
    corpusVersion: CORPUS_VERSION,
    kind: 'review',
    id: input.id ?? randomUUID(),
    at: (input.at ?? new Date()).toISOString(),
    healId: input.heal.id,
    workflowId: input.heal.workflowId,
    verdict: input.verdict,
    reviewer,
  };
  if (input.note !== undefined) record.note = cut(input.note, CORPUS_TEXT_MAX_CHARS);
  return input.redact === undefined ? record : redactDeep(record, input.redact);
}

/** Somewhere corpus records go. */
export interface CorpusWriter {
  write(record: CorpusRecord): void | Promise<void>;
}

/** Keeps records in memory. For tests, and for a benchmark run that reads them back at the end. */
export class MemoryCorpus implements CorpusWriter {
  readonly records: CorpusRecord[] = [];

  write(record: CorpusRecord): void {
    this.records.push(structuredClone(record));
  }
}

export interface JsonlCorpusOptions {
  /** Directory of the corpus. Default `DEFAULT_CORPUS_DIR`, under the working directory. */
  dir?: string;
}

/**
 * Appends records, one JSON object per line, to `heals.jsonl` in the
 * corpus directory, creating the directory on the first write.
 *
 * One writer per directory at a time. Appends from two processes can
 * interleave once a line is longer than the operating system writes in
 * one go, and a record with a patch in it often is.
 */
export class JsonlCorpus implements CorpusWriter {
  readonly file: string;
  private readonly dir: string;
  private ready: Promise<unknown> | undefined;

  constructor(options: JsonlCorpusOptions = {}) {
    this.dir = options.dir ?? DEFAULT_CORPUS_DIR;
    this.file = join(this.dir, CORPUS_FILE);
  }

  async write(record: CorpusRecord): Promise<void> {
    const line = JSON.stringify(record);
    if (line.includes('\n')) {
      // JSON.stringify escapes newlines inside strings, so this cannot
      // happen for a plain record; a toJSON hook could still break a line.
      throw new TypeError('A corpus record must serialise to a single line.');
    }
    this.ready ??= mkdir(this.dir, { recursive: true });
    await this.ready;
    await appendFile(this.file, `${line}\n`, 'utf8');
  }
}

/** A line of the corpus file that could not be read as a record. */
export interface CorpusProblem {
  /** One-based line number. */
  line: number;
  message: string;
}

export interface ReadCorpusResult {
  records: CorpusRecord[];
  /** Lines skipped. A cut-off last line after a crash shows up here. */
  problems: CorpusProblem[];
}

/**
 * Read every record in a corpus directory, in the order written. A missing
 * corpus is empty, not an error. Lines that are not JSON, or are records
 * of another version or kind, are skipped and listed in `problems` rather
 * than thrown, so one torn line does not hide the rest of the history.
 */
export async function readCorpus(dir: string = DEFAULT_CORPUS_DIR): Promise<ReadCorpusResult> {
  let text: string;
  try {
    text = await readFile(join(dir, CORPUS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], problems: [] };
    throw error;
  }
  return parseCorpus(text);
}

/** Parse the text of a corpus file. See `readCorpus`. */
export function parseCorpus(text: string): ReadCorpusResult {
  const records: CorpusRecord[] = [];
  const problems: CorpusProblem[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      problems.push({ line: index + 1, message: 'Not valid JSON.' });
      return;
    }
    const problem = recordProblem(value);
    if (problem !== undefined) {
      problems.push({ line: index + 1, message: problem });
      return;
    }
    records.push(value as CorpusRecord);
  });
  return { records, problems };
}

function recordProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'Not a JSON object.';
  }
  const record = value as Record<string, unknown>;
  if (record['corpusVersion'] !== CORPUS_VERSION) {
    return `Unsupported corpus version ${JSON.stringify(record['corpusVersion'])}.`;
  }
  if (record['kind'] !== 'heal' && record['kind'] !== 'review') {
    return `Unknown record kind ${JSON.stringify(record['kind'])}.`;
  }
  for (const field of ['id', 'at', 'workflowId']) {
    if (typeof record[field] !== 'string') return `Missing ${field}.`;
  }
  if (record['kind'] === 'review' && typeof record['healId'] !== 'string') {
    return 'Missing healId.';
  }
  return undefined;
}

function corpusFailure(error: NonNullable<ReplayOutcome['error']>): CorpusFailure {
  const failure: CorpusFailure = {
    name: error.name,
    message: cut(error.message, PROMPT_ERROR_MAX_CHARS),
  };
  if (error.stepId !== undefined) failure.stepId = error.stepId;
  if (error.action !== undefined) failure.action = error.action;
  if (error.selector !== undefined) failure.selector = { ...error.selector };
  if (error.phase !== undefined) failure.phase = error.phase;
  if (error.reason !== undefined) failure.reason = cut(error.reason, PROMPT_ERROR_MAX_CHARS);
  return failure;
}

function corpusTriage(result: HealResult): CorpusTriage {
  const decision = result.triage;
  if (decision.recovered) {
    return {
      kind: decision.firstTriage.kind,
      rule: decision.firstTriage.rule,
      retried: true,
      recovered: true,
    };
  }
  const triage: CorpusTriage = {
    kind: decision.triage.kind,
    rule: decision.triage.rule,
    route: decision.route,
    retried: decision.retried,
    recovered: false,
  };
  if (decision.firstTriage !== undefined) triage.firstKind = decision.firstTriage.kind;
  return triage;
}

function corpusOutcome(result: HealResult): CorpusOutcome {
  switch (result.status) {
    case 'recovered':
      return { status: 'recovered' };
    case 'routed':
      return { status: 'routed', route: result.route };
    case 'no_evidence':
    case 'not_healed':
      return { status: result.status, reason: result.reason };
    case 'capped':
      return { status: 'capped', cap: result.cap };
    case 'decided':
      return {
        status: 'decided',
        patchClass: result.patchClass,
        decision: result.decision.status,
        hash: result.decision.hash,
      };
  }
}

function corpusAttempt(attempt: HealAttempt): CorpusAttempt {
  const { generated } = attempt;
  const out: CorpusAttempt = { patchClass: attempt.patchClass, status: generated.status };

  if ('call' in generated) {
    out.model = generated.call.model;
    out.promptHash = generated.call.promptHash;
    out.usage = { ...generated.call.usage };
  }
  switch (generated.status) {
    case 'patch':
    case 'needs_approval':
      out.patch = structuredClone(generated.patch);
      out.score = structuredClone(generated.score);
      if (generated.status === 'needs_approval') {
        out.approvals = generated.approvals.map((a) => ({ ...a }));
      }
      break;
    case 'cannot_heal':
      out.rationale = cut(generated.rationale, CORPUS_TEXT_MAX_CHARS);
      break;
    case 'rejected':
      out.stage = generated.stage;
      out.code = generated.code;
      out.message = cut(generated.message, CORPUS_TEXT_MAX_CHARS);
      if (generated.stage === 'policy') out.violations = generated.violations.map((v) => v.code);
      break;
    case 'provider_error':
      out.code = generated.code;
      out.retryable = generated.retryable;
      out.message = cut(generated.message, CORPUS_TEXT_MAX_CHARS);
      break;
  }

  if (attempt.verification !== undefined) {
    out.verification = corpusVerification(attempt.verification);
  }
  if (attempt.decision !== undefined) out.decision = corpusDecision(attempt.decision);
  if (attempt.shadow !== undefined) {
    out.wouldAutoAccept = {
      policy: { ...attempt.shadow.policy },
      eligible: attempt.shadow.eligible,
      reasons: [...attempt.shadow.reasons],
    };
  }
  if (attempt.reversions !== undefined) {
    out.reversions = attempt.reversions.map((r) => ({ code: r.code, at: r.at.toISOString() }));
  }
  return out;
}

function corpusVerification(verification: PatchVerification): CorpusVerification {
  if (verification.status === 'not_applied') {
    return { status: 'not_applied', errors: verification.errors.map((e) => e.message) };
  }
  const { report } = verification;
  const out: CorpusVerification = {
    status: verification.status,
    runs: report.runs,
    passed: report.passed,
    durationsMs: report.replays.map((r) => r.durationMs),
    outputHashes: report.replays.map((r) => canonical(r.outputs)),
  };
  if (verification.status === 'failed') {
    // Drift paths name the fields that differed. Drift values are page
    // content and stay out.
    out.failures = verification.failures.map((f) => {
      const failure: NonNullable<CorpusVerification['failures']>[number] = { code: f.code };
      if (f.run !== undefined) failure.run = f.run;
      if (f.drift !== undefined) failure.paths = f.drift.map((d) => d.path);
      return failure;
    });
  } else {
    out.hash = verification.hash;
    out.stepRan = verification.stepRan;
    if (verification.envelope !== undefined) {
      out.envelope = { status: verification.envelope.status, runs: verification.envelope.runs };
      if (verification.envelope.status === 'outside') {
        out.envelope.deviations = verification.envelope.deviations.map((d) => ({
          path: d.path,
          check: d.check,
        }));
      }
    }
  }
  return out;
}

function corpusDecision(decision: PatchDecision): CorpusDecision {
  switch (decision.status) {
    case 'rejected': {
      const out: CorpusDecision = { status: 'rejected' };
      if (decision.violations !== undefined) {
        out.violations = decision.violations.map((v) => v.code);
      }
      return out;
    }
    case 'awaiting_approval':
      return { status: 'awaiting_approval', reasons: decision.reasons.map((r) => r.code) };
    case 'accepted':
      return { status: 'accepted', acceptedBy: { ...decision.acceptedBy } };
  }
}

function cut(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max)}... (${text.length - max} more characters)`
    : text;
}

/**
 * Copy a JSON value with `redact` applied to every string value in it.
 * Keys are left alone: they are the record's own field names or schema
 * property names, and redacting one would break the record's shape.
 * Throws `TypeError` if `redact` does not return a string, as the prompt
 * builder does: a redactor that fails silently would write secrets to disk.
 */
function redactDeep<T>(value: T, redact: RedactFn): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const out = redact(v);
      if (typeof out !== 'string') throw new TypeError('redact must return a string.');
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        if (inner !== undefined) copy[k] = walk(inner);
      }
      return copy;
    }
    return v;
  };
  return walk(value) as T;
}
