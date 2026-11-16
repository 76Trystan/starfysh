// Model output for one heal attempt.
//
// A model's answer is untrusted text. It was written by a model that read
// page content, and it may be cut off, refused, malformed, or shaped to
// look like something it is not. This file turns that text into one of
// three things: a well-formed `StepPatch`, an explicit "cannot heal", or a
// rejection with a reason. It never throws and never returns a patch that
// has not passed `validateStep` and `validatePatch`.
//
// What this file does not do is judge whether the change is acceptable.
// A patch returned from here is well formed, not approved: limits on what
// a heal may change are checked separately, and nothing here applies or
// runs the patch.

import { validatePatch, validateStep } from '@sfysh/ir';
import type { Step, StepPatch, ValidationError } from '@sfysh/ir';
import type { Completion } from '@sfysh/providers';
import type { HealPrompt } from './prompt.js';

/** Longest model answer that will be parsed, in characters. */
export const RESPONSE_MAX_CHARS = 100_000;
/** Longest rationale kept on a patch. Matches `maxLength` in the patch schema. */
export const RATIONALE_MAX_CHARS = 2_000;

export type HealResponseErrorCode =
  /** The output was cut off (`stopReason` is `max_tokens`). */
  | 'truncated'
  /** The model declined or a safety filter cut the output (`refusal`). */
  | 'refused'
  /** The stop reason is not one that means the output is complete. */
  | 'incomplete'
  /** The answer is longer than `RESPONSE_MAX_CHARS`. */
  | 'too_large'
  /** The answer is not a single JSON value. */
  | 'not_json'
  /** The JSON is not one of the two answer forms the model was given. */
  | 'wrong_shape'
  /** `after` is not a valid IR step. */
  | 'invalid_step'
  /** The assembled patch is not a valid `StepPatch`. */
  | 'invalid_patch';

export type HealResponse =
  | {
      status: 'patch';
      /** A well-formed patch. Not yet checked against any policy, and not applied. */
      patch: StepPatch;
    }
  | {
      status: 'cannot_heal';
      /** The model's explanation of what was missing. Untrusted text, cleaned for display. */
      rationale: string;
    }
  | {
      status: 'rejected';
      code: HealResponseErrorCode;
      /** What was wrong, for logs. Does not quote the model's answer. */
      message: string;
      /** Schema errors, for `invalid_step` and `invalid_patch`. */
      errors?: ValidationError[];
    };

/** The parts of a `HealPrompt` the parser needs. Pass the prompt itself. */
export type HealPatchContext = Pick<HealPrompt, 'workflowId' | 'stepId' | 'before' | 'baseHash'> &
  Partial<Pick<HealPrompt, 'op' | 'newStepId'>>;

const REPLACE_KEYS = new Set(['after', 'rationale', 'confidence']);
const INSERT_KEYS = new Set(['step', 'rationale', 'confidence']);
const CANNOT_HEAL_KEYS = new Set(['cannotHeal', 'rationale']);

/**
 * Turn a model's completion into a patch, a "cannot heal", or a rejection.
 *
 * The stop reason is checked before anything is parsed. Truncated JSON
 * usually fails to parse, but not always: a cut inside a trailing optional
 * field can leave a complete object behind, and that object would be a
 * patch the model never finished writing.
 *
 * The form of the answer depends on `context.op`. For a `replace` (the
 * default) the model gives the whole replacement step under `after`. For
 * an `insert_before` it gives the new step under `step`, and the step is
 * given `context.newStepId` whatever id the model wrote, if any.
 *
 * The answer must be exactly one of the two forms in the system prompt.
 * Any other key is a rejection, so the model cannot supply `stepId`, `op`,
 * `baseHash` or `before`; those come from `context`, which the healer
 * built from the workflow.
 */
export function parseHealResponse(completion: Completion, context: HealPatchContext): HealResponse {
  if (completion.stopReason === 'max_tokens') {
    return reject('truncated', 'The model output was cut off before it finished.');
  }
  if (completion.stopReason === 'refusal') {
    return reject('refused', 'The model declined to answer, or a safety filter cut the output.');
  }
  if (completion.stopReason !== 'end' && completion.stopReason !== 'stop_sequence') {
    return reject(
      'incomplete',
      `The model stopped for a reason that does not mean the output is complete ('${String(completion.stopReason)}').`,
    );
  }

  if (completion.content.length > RESPONSE_MAX_CHARS) {
    return reject(
      'too_large',
      `The model output is ${completion.content.length} characters; the limit is ${RESPONSE_MAX_CHARS}.`,
    );
  }

  let answer: unknown;
  try {
    answer = JSON.parse(stripCodeFence(completion.content));
  } catch {
    return reject('not_json', 'The model output is not a single JSON value.');
  }

  if (!isPlainObject(answer)) {
    return reject('wrong_shape', 'The model output is not a JSON object.');
  }
  const keys = Object.keys(answer);

  if ('cannotHeal' in answer) {
    const extra = keys.filter((key) => !CANNOT_HEAL_KEYS.has(key));
    if (extra.length > 0) {
      return reject(
        'wrong_shape',
        `A "cannotHeal" answer has ${extra.length} key(s) it must not have.`,
      );
    }
    if (answer.cannotHeal !== true) {
      return reject('wrong_shape', '"cannotHeal" must be true when present.');
    }
    const rationale = cleanRationale(answer.rationale);
    if (rationale === undefined) {
      return reject('wrong_shape', '"rationale" must be a non-empty string.');
    }
    return { status: 'cannot_heal', rationale };
  }

  const inserting = context.op === 'insert_before';
  const stepKey = inserting ? 'step' : 'after';
  const allowedKeys = inserting ? INSERT_KEYS : REPLACE_KEYS;
  const extra = keys.filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) {
    return reject('wrong_shape', `The answer has ${extra.length} key(s) it must not have.`);
  }
  if (!(stepKey in answer)) {
    return reject('wrong_shape', `The answer has neither "${stepKey}" nor "cannotHeal".`);
  }
  let proposed: unknown = answer[stepKey];
  if (inserting) {
    if (context.newStepId === undefined) {
      throw new TypeError('An insert_before context must carry newStepId.');
    }
    if (!isPlainObject(proposed)) {
      return reject('wrong_shape', '"step" must be a JSON object.');
    }
    // The id is the healer's to choose. Whatever the model wrote is replaced.
    proposed = { ...proposed, id: context.newStepId };
  }
  const rationale = cleanRationale(answer.rationale);
  if (rationale === undefined) {
    return reject('wrong_shape', '"rationale" must be a non-empty string.');
  }
  const confidence = answer.confidence;
  if (
    confidence !== undefined &&
    !(typeof confidence === 'number' && confidence >= 0 && confidence <= 1)
  ) {
    return reject('wrong_shape', '"confidence" must be a number from 0 to 1.');
  }

  const step = validateStep(proposed);
  if (!step.valid || step.value === undefined) {
    return {
      status: 'rejected',
      code: 'invalid_step',
      message: `"${stepKey}" is not a valid step.`,
      errors: step.errors,
    };
  }

  const candidate: StepPatch = {
    workflowId: context.workflowId,
    baseHash: context.baseHash,
    stepId: context.stepId,
    ...(inserting
      ? { op: 'insert_before' as const }
      : { op: 'replace' as const, before: context.before }),
    after: step.value as Step,
    rationale,
    ...(confidence !== undefined ? { confidence } : {}),
  };

  // Checks the assembled document against the patch schema, and that the
  // replacement kept the id of the step it replaces.
  const patch = validatePatch(candidate);
  if (!patch.valid || patch.value === undefined) {
    return {
      status: 'rejected',
      code: 'invalid_patch',
      message: 'The patch built from the answer is not valid.',
      errors: patch.errors,
    };
  }

  return { status: 'patch', patch: patch.value };
}

function reject(code: HealResponseErrorCode, message: string): HealResponse {
  return { status: 'rejected', code, message };
}

/**
 * Remove one Markdown code fence wrapped around the whole answer. The
 * prompt asks for no fence and models add one anyway. Nothing else is
 * forgiven: prose before or after the JSON, or JSON buried in a sentence,
 * still fails to parse. Searching free text for something that looks like
 * a patch would let page content that the model echoed be picked up as
 * the answer.
 */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match ? match[1]! : trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Control characters other than tab and line feed, plus the Unicode line
// and paragraph separators. A rationale is shown to a reviewer in a
// terminal and written into reports, and it is model-written text.
const UNSAFE_FOR_DISPLAY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Make a rationale safe to show and short enough for the patch schema, or
 * return undefined when there is no usable text. An over-long rationale is
 * cut, not rejected: verbosity is not a reason to throw away a patch.
 */
function cleanRationale(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(UNSAFE_FOR_DISPLAY, ' ').trim();
  if (cleaned === '') return undefined;
  return cleaned.length > RATIONALE_MAX_CHARS ? cleaned.slice(0, RATIONALE_MAX_CHARS) : cleaned;
}
