// heal(): from a failed run to a decision, inside fixed limits.
//
// This is the orchestrator. Every piece it calls exists on its own and is
// tested on its own; what this file adds is the order, and the limits.
//
// 1. Triage the failure (`triageFailure`), with one retry when triage says
//    a retry is worth it. Only a `heal` route goes further. Every other
//    route is returned without a model call.
// 2. Check the daily cap for the workflow, and record the run.
// 3. Try the patch classes in order. A failure that says the element was
//    covered tries an inserted step first; anything else tries new
//    selectors first. Each class gets one model call, plus a retry of the
//    same class after a transient provider error.
// 4. Verify each patch live against the known-good outputs, then decide
//    (`verifyPatch`, `decidePatch`). The first patch that is accepted or
//    held for approval ends the heal. A patch that fails verification moves
//    on to the next class. A verified patch that undoes an earlier heal
//    (`findReversions`) is always held for a person, and every decided
//    heal is recorded in the history so later heals can be checked.
//
// The attempt and token caps are checked before every model call.

import type { Workflow } from '@sfysh/ir';
import type { Provider, RedactFn, TokenUsage } from '@sfysh/providers';
import type { PageFactory, ReplayOutcome } from '@sfysh/verifier';
import { decidePatch, verifyPatch } from './accept.js';
import type {
  AcceptancePolicy,
  KnownGood,
  PatchDecision,
  PatchVerification,
  VerifyPatchInput,
} from './accept.js';
import type { ModelPatchClass } from './allowlist.js';
import {
  DEFAULT_HEAL_MAX_TOKENS,
  generateInsertStepPatch,
  generateSelectorPatch,
} from './generate.js';
import type { GeneratePatchInput, GeneratePatchResult } from './generate.js';
import { HEAL_WINDOW_MS, resolveHealLimits } from './limits.js';
import type { HealHistory, HealLimits } from './limits.js';
import type { HealFailure } from './prompt.js';
import { findReversions, patchRecord } from './revert.js';
import type { Reversion } from './revert.js';
import { triageFailure } from './triage.js';
import type { HealRoute, TriageDecision } from './triage.js';

/** Options passed through to `verifyPatch` for every patch. */
export type HealVerifyOptions = Pick<
  VerifyPatchInput,
  | 'runs'
  | 'tolerance'
  | 'params'
  | 'runner'
  | 'vaultResolver'
  | 'runTimeoutMs'
  | 'snapshot'
  | 'dispose'
>;

export interface HealInput {
  /** The workflow that failed. */
  workflow: Workflow;
  /** The failed run, from `replay()`. It must carry a page snapshot for a heal to go ahead. */
  outcome: ReplayOutcome;
  /** Outputs of the last run that passed. Every patch is held to them. */
  knownGood: KnownGood;
  /** The model to ask. */
  provider: Provider;
  /** Redaction for everything sent to the model: the failed run's `ctx.redact`, or one with the same secrets registered. */
  redact: RedactFn;
  /** A fresh live page per verification run. */
  pageFactory: PageFactory;
  /** Where heal runs are counted for the daily cap. */
  history: HealHistory;
  /** Run the original workflow once more, for triage's single retry. */
  retry?: () => Promise<ReplayOutcome>;
  verify?: HealVerifyOptions;
  /** Default: every patch waits for a person. */
  policy?: AcceptancePolicy;
  /** Defaults in `DEFAULT_HEAL_LIMITS`. */
  limits?: Partial<HealLimits>;
  /** Longest one model call may take. See `generateSelectorPatch`. */
  timeoutMs?: number;
  /** Cancels the model calls. */
  signal?: AbortSignal;
  /** Cap on the snapshot text in the prompt. */
  maxSnapshotChars?: number;
  /** Clock, for the daily cap. Tests pass a fixed one. */
  now?: () => Date;
}

/** One trip through a generator, and what became of its patch. */
export interface HealAttempt {
  patchClass: ModelPatchClass;
  generated: GeneratePatchResult;
  /** Present when the generator returned a patch. */
  verification?: PatchVerification;
  /** Present when verification passed. */
  decision?: PatchDecision;
  /** Earlier heals this patch undoes. Present only when there are some. */
  reversions?: Reversion[];
}

/**
 * Which limit stopped a heal. `budget` is a spend limit outside this heal: a
 * `MeteredProvider` from `@sfysh/providers` refused the call because a
 * budget shared across heals is spent.
 */
export type HealCap = 'heals_per_day' | 'attempts' | 'tokens' | 'budget';

export type HealResult =
  | {
      /** Triage's retry passed. Nothing needed healing. */
      status: 'recovered';
      triage: TriageDecision;
    }
  | {
      /**
       * Triage sent the failure somewhere other than the healer. No model
       * was called. `draft_for_approval` (a task change) lands here too:
       * neither generator can add the missing input, so a person must.
       */
      status: 'routed';
      route: Exclude<HealRoute, 'heal'>;
      triage: TriageDecision;
    }
  | {
      /** The failure was routed to `heal` but there is not enough to heal from. No model was called. */
      status: 'no_evidence';
      reason: 'no_snapshot' | 'no_step';
      triage: TriageDecision;
    }
  | {
      /** A limit stopped the heal before it found a patch. */
      status: 'capped';
      cap: HealCap;
      triage: TriageDecision;
      attempts: HealAttempt[];
      usage: TokenUsage;
    }
  | {
      /** A patch verified. It is accepted, or waiting for a person. */
      status: 'decided';
      decision: Extract<PatchDecision, { status: 'accepted' | 'awaiting_approval' }>;
      patchClass: ModelPatchClass;
      triage: TriageDecision;
      attempts: HealAttempt[];
      usage: TokenUsage;
    }
  | {
      /**
       * No patch verified. `exhausted`: every class was tried.
       * `provider_error`: the provider failed in a way a retry will not fix.
       */
      status: 'not_healed';
      reason: 'exhausted' | 'provider_error';
      triage: TriageDecision;
      attempts: HealAttempt[];
      usage: TokenUsage;
    };

// Wording that says an action reached the right element but something on
// top of it took the click: Playwright's "intercepts pointer events", and
// the plainer "covered by another element".
const COVERED = /intercepts pointer events|covered by another element/i;

/** The order the patch classes are tried in for this failure. */
export function patchClassOrder(failure: Pick<HealFailure, 'message'>): ModelPatchClass[] {
  return COVERED.test(failure.message) ? ['insert_step', 'selector'] : ['selector', 'insert_step'];
}

/**
 * Heal one failed run.
 *
 * Never throws for anything the site, the model or the provider does;
 * those come back as a result. Throws for a mistake in the arguments
 * (invalid limits, a run that did not fail, a bad verification run count)
 * and rejects if `retry` or `history` does.
 */
export async function heal(input: HealInput): Promise<HealResult> {
  const limits = resolveHealLimits(input.limits);
  const now = input.now ?? (() => new Date());
  const { workflow } = input;

  const triage = await triageFailure(
    input.outcome,
    input.retry !== undefined ? { retry: input.retry } : {},
  );
  if (triage.recovered) return { status: 'recovered', triage };
  if (triage.route !== 'heal') return { status: 'routed', route: triage.route, triage };

  const error = triage.outcome.error!;
  const snapshot = triage.outcome.snapshot;
  if (snapshot === undefined) return { status: 'no_evidence', reason: 'no_snapshot', triage };
  if (error.stepId === undefined) return { status: 'no_evidence', reason: 'no_step', triage };

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const attempts: HealAttempt[] = [];

  const started = now();
  const recent = await input.history.count(
    workflow.id,
    new Date(started.getTime() - HEAL_WINDOW_MS),
  );
  if (recent >= limits.maxHealsPerWorkflowPerDay) {
    return { status: 'capped', cap: 'heals_per_day', triage, attempts, usage };
  }
  await input.history.record(workflow.id, started);

  const failure: HealFailure = {
    name: error.name,
    message: error.message,
    stepId: error.stepId,
    ...(error.action !== undefined ? { action: error.action } : {}),
    ...(error.selector !== undefined ? { selector: error.selector } : {}),
    ...(error.phase !== undefined ? { phase: error.phase } : {}),
    ...(error.condition !== undefined ? { condition: error.condition } : {}),
    ...(error.reason !== undefined ? { reason: error.reason } : {}),
  };
  const classes = patchClassOrder(failure);

  let calls = 0;
  let next = 0;
  while (next < classes.length) {
    if (calls >= limits.maxAttemptsPerFailure) {
      return { status: 'capped', cap: 'attempts', triage, attempts, usage };
    }
    const spent = usage.inputTokens + usage.outputTokens;
    if (spent >= limits.maxTokensPerHeal) {
      return { status: 'capped', cap: 'tokens', triage, attempts, usage };
    }

    const patchClass = classes[next]!;
    const generatorInput: GeneratePatchInput = {
      workflow,
      failure,
      snapshot,
      redact: input.redact,
      provider: input.provider,
      triage: { kind: triage.triage.kind, rule: triage.triage.rule, reason: triage.triage.reason },
      // The output cap never lets one answer take the heal past its token budget.
      maxTokens: Math.min(DEFAULT_HEAL_MAX_TOKENS, limits.maxTokensPerHeal - spent),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.maxSnapshotChars !== undefined ? { maxSnapshotChars: input.maxSnapshotChars } : {}),
    };
    const generated =
      patchClass === 'selector'
        ? await generateSelectorPatch(generatorInput)
        : await generateInsertStepPatch(generatorInput);
    const attempt: HealAttempt = { patchClass, generated };
    attempts.push(attempt);

    // An input rejection is decided before any request is sent, so it
    // costs neither an attempt nor tokens.
    if (!(generated.status === 'rejected' && generated.stage === 'input')) calls++;
    if ('call' in generated) {
      usage.inputTokens += generated.call.usage.inputTokens;
      usage.outputTokens += generated.call.usage.outputTokens;
    }

    if (generated.status === 'provider_error') {
      if (generated.retryable) continue;
      if (generated.code === 'budget_exceeded') {
        return { status: 'capped', cap: 'budget', triage, attempts, usage };
      }
      return { status: 'not_healed', reason: 'provider_error', triage, attempts, usage };
    }

    if (generated.status === 'patch' || generated.status === 'needs_approval') {
      const verification = await verifyPatch({
        ...input.verify,
        workflow,
        patch: generated.patch,
        knownGood: input.knownGood,
        pageFactory: input.pageFactory,
      });
      attempt.verification = verification;
      if (verification.status === 'verified') {
        const reversions = findReversions(
          generated.patch,
          workflow,
          await input.history.patches(workflow.id),
        );
        if (reversions.length > 0) attempt.reversions = reversions;
        const decision = decidePatch({
          workflow,
          patchClass,
          score: generated.score,
          verification,
          reversions,
          ...(input.policy !== undefined ? { policy: input.policy } : {}),
        });
        attempt.decision = decision;
        if (decision.status !== 'rejected') {
          // Recorded whether accepted or held: the state this heal started
          // from is one the workflow really was in, which is what a later
          // reversion is measured against.
          const record = patchRecord(workflow, generated.patch, decision.status, now());
          if (record !== undefined) await input.history.recordPatch(record);
          return { status: 'decided', decision, patchClass, triage, attempts, usage };
        }
      }
    }

    next++;
  }

  return { status: 'not_healed', reason: 'exhausted', triage, attempts, usage };
}
