// The patch generators: one model call, from a failed step to a checked
// patch. There is one for each kind of heal, and they share everything
// but the instructions the model is given and the rules the answer is
// held to.
//
// This is the only place in the package that calls a model. The order of
// work is fixed:
//
// 1. Build the prompt (`buildHealPrompt`), which redacts and delimits
//    everything the model is shown.
// 2. Call the provider through `RedactingProvider`, with a timeout, so a
//    prompt that somehow kept a secret still cannot send it, and a slow
//    vendor cannot hang the heal.
// 3. Parse the answer (`parseHealResponse`) into a well-formed patch.
// 4. Put the candidates in ranked order.
// 5. Run every patch check (`checkPatch`) for the class that was asked for.
//
// Nothing here applies the patch, runs it or verifies it. A patch that
// comes back is a proposal that broke no rule.

import type { SelectorCandidate, Step, StepPatch, Workflow } from '@sfysh/ir';
import { ProviderError, RedactingProvider } from '@sfysh/providers';
import type { Provider, ProviderErrorCode, RedactFn, TokenUsage } from '@sfysh/providers';
import type { PageSnapshot } from '@sfysh/runtime';
import type { PatchClass } from './allowlist.js';
import { checkPatch } from './check.js';
import type { PatchViolation } from './check.js';
import { buildHealPrompt, HealInputError } from './prompt.js';
import type { HealFailure, HealTriage } from './prompt.js';
import { parseHealResponse } from './response.js';
import type { ReachApproval } from './reach.js';

/** How long one model call may take before the generator gives up, in milliseconds. */
export const DEFAULT_HEAL_TIMEOUT_MS = 60_000;
/** Output cap for one model call. A step is small; an answer that needs more has gone wrong. */
export const DEFAULT_HEAL_MAX_TOKENS = 2_000;
/** Most selector candidates a healed step may carry. */
export const MAX_SELECTOR_CANDIDATES = 5;

/**
 * Preference order for selector candidates. Role selectors survive a
 * redesign best because they describe meaning, test ids next because they
 * are put there to be stable, and CSS last because it describes layout.
 */
export const CANDIDATE_ORDER: readonly SelectorCandidate['kind'][] = [
  'role',
  'testid',
  'label',
  'text',
  'css',
];

export interface GeneratePatchInput {
  /** The workflow as it was when the run failed. */
  workflow: Workflow;
  /** The failure. Must name a step. For a selector heal the step must have a `target`. */
  failure: HealFailure;
  /** Accessibility snapshot of the page at the point of failure. */
  snapshot: PageSnapshot;
  /** The run's redaction function (`ctx.redact`). */
  redact: RedactFn;
  /** The model to ask. It is wrapped in a `RedactingProvider` here; passing one already wrapped is fine. */
  provider: Provider;
  /** Triage result for the failure, when available. */
  triage?: HealTriage;
  /** Longest the model call may take. Default 60 seconds. */
  timeoutMs?: number;
  /** Output cap for the model call. Default 2,000 tokens. */
  maxTokens?: number;
  /** Cancels the model call when it aborts. */
  signal?: AbortSignal;
  /** Cap on the snapshot text in the prompt. See `buildHealPrompt`. */
  maxSnapshotChars?: number;
  /** Source of the delimiter id. See `buildHealPrompt`. Tests pass a fixed value. */
  nonce?: () => string;
}

/** What the model call cost. Present on every result that got an answer back. */
export interface HealCall {
  /** The exact model that answered. */
  model: string;
  usage: TokenUsage;
}

export type GeneratePatchRejection =
  | {
      /** No model call was made: a safe prompt could not be built, or the step has no target. */
      stage: 'input';
      code: string;
      message: string;
    }
  | {
      /** The answer was cut off, refused, malformed or not a valid step. */
      stage: 'response';
      code: string;
      message: string;
      call: HealCall;
    }
  | {
      /** The candidates the model gave cannot be used. */
      stage: 'candidates';
      code: 'visual_candidate' | 'too_many_candidates';
      message: string;
      call: HealCall;
    }
  | {
      /** The patch is well formed and breaks a rule. `code` is the first violation's. */
      stage: 'policy';
      code: string;
      message: string;
      violations: PatchViolation[];
      call: HealCall;
    };

/**
 * Only `patch` is a proposal that may move on to verification on its own.
 * `needs_approval` carries a patch that broke no rule but must not be
 * accepted until a person has confirmed each listed point, whatever a
 * later verification run says.
 */
export type GeneratePatchResult =
  | { status: 'patch'; patch: StepPatch; call: HealCall }
  | { status: 'needs_approval'; patch: StepPatch; approvals: ReachApproval[]; call: HealCall }
  | {
      status: 'cannot_heal';
      /** The model's explanation. Untrusted text, cleaned for display. */
      rationale: string;
      call: HealCall;
    }
  | ({ status: 'rejected' } & GeneratePatchRejection)
  | {
      /** The model call itself failed. */
      status: 'provider_error';
      code: ProviderErrorCode;
      /** Whether the same call is worth one more try. */
      retryable: boolean;
      /** The provider's message, redacted. */
      message: string;
    };

/**
 * Ask a model for new selectors for a failed step and return a checked
 * patch.
 *
 * Call this only for a failure triage routed to `heal`. One call is one
 * attempt: there is no retry in here, so the caller decides whether a
 * `provider_error` marked retryable or a malformed answer is worth
 * another.
 *
 * It does not throw for anything the model, the provider or the page can
 * cause; those all come back as a result. It does throw for a mistake in
 * the arguments (a bad `timeoutMs`, a `redact` that does not return a
 * string), because retrying or escalating would not fix that.
 */
export function generateSelectorPatch(input: SelectorPatchInput): Promise<SelectorPatchResult> {
  return generate(input, 'selector');
}

/**
 * Ask a model for one new step to run before a failed step, and return a
 * checked patch.
 *
 * This is for a page that now puts something in the way of a step that
 * is itself still right: a banner to dismiss, an extra button to press,
 * content that takes longer to appear. The new step is a `click` or a
 * `wait` for a condition, inserted before the failed step. Its id and its
 * position are chosen here, not by the model.
 *
 * Everything said about `generateSelectorPatch` holds: call it only for a
 * failure routed to `heal`, one call is one attempt, and it throws only
 * for a mistake in the arguments. Which of the two to try, and in what
 * order, is the caller's decision.
 */
export function generateInsertStepPatch(
  input: InsertStepPatchInput,
): Promise<InsertStepPatchResult> {
  return generate(input, 'insert_step');
}

export type SelectorPatchInput = GeneratePatchInput;
export type SelectorPatchResult = GeneratePatchResult;
export type SelectorPatchRejection = GeneratePatchRejection;
export type InsertStepPatchInput = GeneratePatchInput;
export type InsertStepPatchResult = GeneratePatchResult;

async function generate(
  input: GeneratePatchInput,
  patchClass: PatchClass,
): Promise<GeneratePatchResult> {
  const { workflow, redact } = input;

  let prompt;
  try {
    prompt = buildHealPrompt({
      workflow,
      failure: input.failure,
      snapshot: input.snapshot,
      redact,
      patchClass,
      ...(input.triage !== undefined ? { triage: input.triage } : {}),
      ...(input.maxSnapshotChars !== undefined ? { maxSnapshotChars: input.maxSnapshotChars } : {}),
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    });
  } catch (error) {
    if (error instanceof HealInputError) {
      return { status: 'rejected', stage: 'input', code: error.code, message: error.message };
    }
    throw error;
  }
  if (patchClass === 'selector' && (prompt.before as { target?: unknown }).target === undefined) {
    return {
      status: 'rejected',
      stage: 'input',
      code: 'no_target',
      message: 'The failed step has no target, so new selectors cannot repair it.',
    };
  }

  let completion;
  try {
    completion = await new RedactingProvider(input.provider, redact).complete(prompt.messages, {
      maxTokens: input.maxTokens ?? DEFAULT_HEAL_MAX_TOKENS,
      timeoutMs: input.timeoutMs ?? DEFAULT_HEAL_TIMEOUT_MS,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        status: 'provider_error',
        code: error.code,
        retryable: error.retryable,
        message: redact(error.message),
      };
    }
    throw error;
  }
  const call: HealCall = { model: completion.model, usage: completion.usage };

  const response = parseHealResponse(completion, prompt);
  if (response.status === 'cannot_heal') {
    return { status: 'cannot_heal', rationale: response.rationale, call };
  }
  if (response.status === 'rejected') {
    return {
      status: 'rejected',
      stage: 'response',
      code: response.code,
      message: response.message,
      call,
    };
  }

  const ordered = orderCandidates(response.patch);
  if ('code' in ordered) return { status: 'rejected', stage: 'candidates', ...ordered, call };
  const patch = ordered.patch;

  const verdict = checkPatch(patch, workflow, patchClass);
  if (verdict.status === 'rejected') {
    const first = verdict.violations[0]!;
    return {
      status: 'rejected',
      stage: 'policy',
      code: first.code,
      message: first.message,
      violations: verdict.violations,
      call,
    };
  }
  if (verdict.status === 'needs_approval') {
    return { status: 'needs_approval', patch, approvals: verdict.approvals, call };
  }
  return { status: 'patch', patch, call };
}

type CandidateProblem = {
  code: 'visual_candidate' | 'too_many_candidates';
  message: string;
};

/**
 * Put a patch's candidates in preference order and drop exact repeats.
 *
 * The prompt asks for this order and the model usually complies. Doing it
 * in code means the first candidate, which is the one generated code
 * uses, is always the most durable kind the model found, and a patch does
 * not differ from run to run only by the order of its candidates.
 * Candidates of the same kind keep the order the model gave them.
 *
 * A `visual` candidate is refused: its value is a reference to a stored
 * embedding, which a model cannot have, so one in an answer is made up.
 */
function orderCandidates(patch: StepPatch): { patch: StepPatch } | CandidateProblem {
  const after = patch.after as unknown as { target?: { candidates?: SelectorCandidate[] } };
  const given = after.target?.candidates;
  // A step with no target is left for the policy checks to refuse.
  if (!Array.isArray(given)) return { patch };

  if (given.some((candidate) => candidate.kind === 'visual')) {
    return {
      code: 'visual_candidate',
      message: 'The answer has a "visual" selector candidate, which a model cannot supply.',
    };
  }

  const seen = new Set<string>();
  const unique = given.filter((candidate) => {
    const key = JSON.stringify([candidate.kind, candidate.value]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > MAX_SELECTOR_CANDIDATES) {
    return {
      code: 'too_many_candidates',
      message: `The answer has ${unique.length} selector candidates; the limit is ${MAX_SELECTOR_CANDIDATES}.`,
    };
  }

  const rank = (candidate: SelectorCandidate) => CANDIDATE_ORDER.indexOf(candidate.kind);
  const candidates = unique
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.index - b.index)
    .map(({ candidate }) => candidate);

  return {
    patch: {
      ...patch,
      after: { ...after, target: { ...after.target, candidates } } as unknown as Step,
    },
  };
}
