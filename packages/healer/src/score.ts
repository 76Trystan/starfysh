// Confidence scoring: how much evidence there is that a patch is right.
//
// A model's own confidence is a number it wrote after reading a page it
// may have been misled by, so it is not used as the score. The score here
// is worked out in code from things that can be checked without running
// the patch: does the first selector name something that is in the page
// snapshot, exactly once; is it a durable kind of selector; did the model
// invent an element that is not there.
//
// The score is evidence, not proof. A patch can score high and still be a
// false heal, which is what verification and review are for. The weights
// are starting values and have not been calibrated against real heals.

import { findStep, parseRoleSelector } from '@sfysh/ir';
import type { SelectorCandidate, StepPatch, Workflow } from '@sfysh/ir';
import type { PatchClass } from './allowlist.js';

/** A score at or above this is `high`. */
export const CONFIDENCE_HIGH = 0.8;
/** A score at or above this, and below `CONFIDENCE_HIGH`, is `medium`. */
export const CONFIDENCE_MEDIUM = 0.5;
/** The most an insert-step patch can score. A new step is a bigger change than a new selector. */
export const INSERT_STEP_MAX_SCORE = 0.6;

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type ScoreSignalCode =
  /** Where the score starts for this kind of patch. */
  | 'base'
  /** The first candidate names exactly one element in the snapshot. */
  | 'first_candidate_unique'
  /** The first candidate names several elements in the snapshot. */
  | 'first_candidate_ambiguous'
  /** The first candidate names nothing in the snapshot. */
  | 'first_candidate_not_found'
  /** The first candidate is a kind the snapshot cannot confirm (css, testid). */
  | 'first_candidate_unverifiable'
  /** How durable the first candidate's kind is. */
  | 'first_candidate_kind'
  /** A fallback candidate names exactly one element in the snapshot. */
  | 'fallback_grounded'
  /** A fallback candidate names nothing in the snapshot. */
  | 'fallback_not_found'
  /** The new first candidate has the same role as the old one. */
  | 'same_role'
  /** The text an inserted wait looks for is in the snapshot. */
  | 'wait_text_found'
  /** The snapshot was cut short, so absence from it proves less. */
  | 'snapshot_truncated'
  /** An inserted click names something that reads like a commitment (buy, delete, submit). */
  | 'risky_click'
  /** The score was held to the ceiling for insert-step patches. */
  | 'insert_step_cap'
  /** The model reported less confidence than the evidence gave. */
  | 'model_less_confident';

export interface ScoreSignal {
  code: ScoreSignalCode;
  /** What this signal added to or took from the score. */
  effect: number;
  /** What was found. Does not quote the patch or the page. */
  detail: string;
}

export interface PatchScore {
  /** From 0 to 1, to two decimal places. */
  score: number;
  level: ConfidenceLevel;
  /** Every signal that went into the score, in the order applied. */
  signals: ScoreSignal[];
  /** The confidence the model reported, if it gave one. Kept for the record; it can lower the score and never raise it. */
  modelConfidence?: number;
}

export interface ScorePatchInput {
  /** A patch that has passed `checkPatch`. `confidence` on it is read as the model's own. */
  patch: StepPatch;
  /** The workflow the patch is for. */
  workflow: Workflow;
  /** The page snapshot the patch was derived from. */
  snapshot: { text: string; truncated: boolean };
  /** The kind of heal the patch was requested as. */
  patchClass: PatchClass;
}

type Loose = Record<string, unknown>;

/**
 * Score a patch from 0 to 1 on the evidence that it is right.
 *
 * Pure and deterministic: the same patch and snapshot always give the
 * same score, and the signals say how it was reached. Nothing here runs
 * the patch.
 */
export function scorePatch(input: ScorePatchInput): PatchScore {
  const { patch, snapshot, patchClass } = input;
  const after = patch.after as unknown as Loose;
  const elements = parseSnapshot(snapshot.text);
  const lowerText = snapshot.text.toLowerCase();

  const signals: ScoreSignal[] = [];
  let total = 0;
  const add = (code: ScoreSignalCode, effect: number, detail: string) => {
    signals.push({ code, effect, detail });
    total += effect;
  };

  add(
    'base',
    patchClass === 'insert_step' ? 0.3 : 0.5,
    patchClass === 'insert_step'
      ? 'Starting value for a new step.'
      : 'Starting value for new selectors.',
  );

  const candidates = candidatesOf(after);
  const first = candidates[0];
  let sawAbsence = false;
  if (first !== undefined) {
    const grounding = ground(first, elements, lowerText);
    if (grounding === 'unique') {
      add(
        'first_candidate_unique',
        0.3,
        'The first selector names exactly one element in the snapshot.',
      );
    } else if (grounding === 'ambiguous') {
      add(
        'first_candidate_ambiguous',
        0.05,
        'The first selector names more than one element in the snapshot.',
      );
    } else if (grounding === 'not_found') {
      sawAbsence = true;
      add('first_candidate_not_found', -0.3, 'The first selector names nothing in the snapshot.');
    } else {
      add(
        'first_candidate_unverifiable',
        0,
        'The first selector is a kind the snapshot cannot confirm.',
      );
    }

    const kindEffect = { role: 0.1, testid: 0.05, label: 0, text: 0, css: -0.1, visual: -0.1 }[
      first.kind
    ];
    add('first_candidate_kind', kindEffect, `The first selector is of kind "${first.kind}".`);

    const fallbacks = candidates
      .slice(1)
      .map((candidate) => ground(candidate, elements, lowerText));
    if (fallbacks.includes('unique')) {
      add(
        'fallback_grounded',
        0.05,
        'A fallback selector names exactly one element in the snapshot.',
      );
    }
    if (fallbacks.includes('not_found')) {
      sawAbsence = true;
      add('fallback_not_found', -0.1, 'A fallback selector names nothing in the snapshot.');
    }

    if (patch.op === 'replace' && first.kind === 'role') {
      const current = findStep(input.workflow, patch.stepId)?.step as unknown as Loose | undefined;
      const old = current === undefined ? undefined : candidatesOf(current)[0];
      if (
        old?.kind === 'role' &&
        parseRoleSelector(old.value).role.toLowerCase() ===
          parseRoleSelector(first.value).role.toLowerCase()
      ) {
        add('same_role', 0.05, 'The new first selector has the same role as the old one.');
      }
    }
  }

  if (after.action === 'wait') {
    const text = (after.forCondition as Loose | undefined)?.textPresent;
    if (typeof text === 'string' && text !== '' && lowerText.includes(text.toLowerCase())) {
      add('wait_text_found', 0.1, 'The text the new step waits for is in the snapshot.');
    }
  }

  if (snapshot.truncated) {
    add(
      'snapshot_truncated',
      sawAbsence ? 0 : -0.1,
      sawAbsence
        ? 'The snapshot was cut short, so a selector that was not found may be past the end.'
        : 'The snapshot was cut short, so the model did not see the whole page.',
    );
  }

  if (patch.op !== 'replace' && after.action === 'click' && candidates.some(readsAsCommitment)) {
    add('risky_click', -0.4, 'The new step clicks something that reads like a commitment.');
  }

  let score = clamp(total);
  if (patchClass === 'insert_step' && score > INSERT_STEP_MAX_SCORE) {
    add(
      'insert_step_cap',
      round(INSERT_STEP_MAX_SCORE - score),
      'A new step cannot score above the ceiling for its kind.',
    );
    score = INSERT_STEP_MAX_SCORE;
  }

  const modelConfidence = typeof patch.confidence === 'number' ? patch.confidence : undefined;
  if (modelConfidence !== undefined && modelConfidence < score) {
    add(
      'model_less_confident',
      round(modelConfidence - score),
      'The model reported less confidence than the evidence gave.',
    );
    score = modelConfidence;
  }

  score = round(clamp(score));
  return {
    score,
    level: score >= CONFIDENCE_HIGH ? 'high' : score >= CONFIDENCE_MEDIUM ? 'medium' : 'low',
    signals: signals.map((signal) => ({ ...signal, effect: round(signal.effect) })),
    ...(modelConfidence !== undefined ? { modelConfidence } : {}),
  };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function candidatesOf(step: Loose): SelectorCandidate[] {
  const list = (step.target as { candidates?: unknown } | undefined)?.candidates;
  return Array.isArray(list) ? (list as SelectorCandidate[]) : [];
}

interface SnapshotElement {
  role: string;
  /** Accessible name, lower-cased. Empty when the element has none. */
  name: string;
}

/**
 * Read the elements out of an accessibility snapshot. Each line of the
 * form `- role "name"` is one element; the name is optional. Lines that do
 * not fit (plain text nodes, properties) are skipped.
 */
function parseSnapshot(text: string): SnapshotElement[] {
  const elements: SnapshotElement[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(line);
    if (match === null) continue;
    elements.push({
      role: match[1]!.toLowerCase(),
      name: (match[2] ?? '').replace(/\\(.)/g, '$1').toLowerCase(),
    });
  }
  return elements;
}

type Grounding = 'unique' | 'ambiguous' | 'not_found' | 'unverifiable';

/**
 * Whether the snapshot backs a candidate up. A role candidate is matched
 * on role and, when it gives one, on the accessible name as a
 * case-insensitive substring, which is how a role lookup matches a name
 * by default. Label and text candidates are matched as text anywhere in
 * the snapshot. A css selector or a test id is not something an
 * accessibility tree shows, so those cannot be confirmed either way.
 */
function ground(
  candidate: SelectorCandidate,
  elements: readonly SnapshotElement[],
  lowerText: string,
): Grounding {
  let count: number;
  if (candidate.kind === 'role') {
    const { role, options } = parseRoleSelector(candidate.value);
    const name = options.name?.toLowerCase();
    count = elements.filter(
      (element) =>
        element.role === role.toLowerCase() && (name === undefined || element.name.includes(name)),
    ).length;
  } else if (candidate.kind === 'label' || candidate.kind === 'text') {
    const needle = candidate.value.toLowerCase();
    if (needle === '') return 'not_found';
    count = lowerText.split(needle).length - 1;
  } else {
    return 'unverifiable';
  }
  return count === 0 ? 'not_found' : count === 1 ? 'unique' : 'ambiguous';
}

/**
 * Words that, on a button an inserted step would click, suggest the click
 * commits to something. English only, and a word match: it lowers the
 * score, it does not block anything.
 */
const COMMITMENT_WORDS =
  /\b(?:submit|buy|purchase|pay|order|checkout|delete|remove|send|confirm|transfer|subscribe|sign\s*up|place)\b/i;

function readsAsCommitment(candidate: SelectorCandidate): boolean {
  const text =
    candidate.kind === 'role'
      ? (parseRoleSelector(candidate.value).options.name ?? '')
      : candidate.value;
  return COMMITMENT_WORDS.test(text.replace(/[-_]/g, ' '));
}
