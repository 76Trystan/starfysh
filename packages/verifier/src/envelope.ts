// Output envelope: what a workflow's outputs normally look like.
//
// Matching the last known-good run exactly is the first defence against a
// false heal, but it has a hole: a field the tolerance map exempts (a
// price that moves, an ignored timestamp column) can change completely
// and still match. A heal that starts reading the wrong column of a table
// passes if that column happens to be tolerated. ADR 0004 closes the hole
// with a second check against the distribution of the last N passing
// runs: not the values, but what kind of values they were.
//
// The envelope is learnt per field path, with array positions folded
// together (`*.rows.*.sku`), so every row of a table contributes:
//
// - the JSON types seen (a field that was always a number);
// - presence (a field every run produced);
// - for arrays, a band of lengths (a table that never had fewer than 8
//   rows suddenly has 1);
// - for numbers, a range, widened by its own spread (quantities between 3
//   and 14, not reorder levels of 40);
// - for strings, a shape: runs of letters, digits and spaces reduced to
//   one symbol each, punctuation kept (`A-001` is `a-9`; `Widget` is `a`).
//
// Tolerance exempts a field from the value checks (range only), never
// from the kind checks (type, presence, length, shape). A tolerated field
// may move; it may not turn into a different kind of thing.
//
// Pure: no I/O, no model. Messages describe the field and the check, never
// the values, which are page content.

import { resolveRule } from './stability.js';
import type { ToleranceMap } from './types.js';

/** Fewest passing runs an envelope is learnt from. Below this the check is skipped and says so. */
export const MIN_ENVELOPE_RUNS = 3;

/** How many passing runs a known-good history keeps. ADR 0004's N. */
export const ENVELOPE_HISTORY_RUNS = 10;

/** A string field whose history shows more distinct shapes than this has no shape to check. */
const MAX_SHAPES = 2;

type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

interface FieldEnvelope {
  types: Set<JsonType>;
  /** History runs in which the field appeared at least once. */
  presentIn: number;
  minLength?: number;
  maxLength?: number;
  minNumber?: number;
  maxNumber?: number;
  shapes: Set<string>;
  /** Some concrete path for this field has a tolerance rule. */
  tolerated: boolean;
}

/** The learnt envelope. Opaque to callers; build with `learnEnvelope`, test with `checkEnvelope`. */
export interface OutputEnvelope {
  runs: number;
  fields: Map<string, FieldEnvelope>;
}

export type EnvelopeCheck =
  /** A field every history run produced is absent. */
  | 'missing'
  /** A field no history run produced appears. */
  | 'unexpected'
  /** A field has a JSON type it never had. */
  | 'type'
  /** An array is far shorter or longer than any history run's. */
  | 'length'
  /** A number lies well outside the range the history showed. */
  | 'range'
  /** A string has a different shape from the one or two the history showed. */
  | 'shape';

export interface EnvelopeDeviation {
  /** Field path with array positions as `*`, for example `*.rows.*.qty`. */
  path: string;
  check: EnvelopeCheck;
  /** What differs, without quoting any value. */
  message: string;
}

export type EnvelopeResult =
  | { status: 'within'; runs: number }
  | { status: 'outside'; runs: number; deviations: EnvelopeDeviation[] }
  /** Fewer than `MIN_ENVELOPE_RUNS` history runs: nothing was checked. */
  | { status: 'insufficient_history'; runs: number };

/** Learn the envelope of a list of passing runs' outputs. */
export function learnEnvelope(
  history: readonly unknown[][],
  tolerance: ToleranceMap = {},
): OutputEnvelope {
  const fields = new Map<string, FieldEnvelope>();
  for (const outputs of history) {
    const seen = new Set<string>();
    visit(outputs, '', '', (field, concrete, value) => {
      const f = fields.get(field) ?? newField();
      fields.set(field, f);
      if (!seen.has(field)) {
        seen.add(field);
        f.presentIn++;
      }
      if (resolveRule(concrete, tolerance) !== undefined) f.tolerated = true;
      const type = typeOf(value);
      f.types.add(type);
      if (Array.isArray(value)) {
        f.minLength = Math.min(f.minLength ?? Infinity, value.length);
        f.maxLength = Math.max(f.maxLength ?? -Infinity, value.length);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        f.minNumber = Math.min(f.minNumber ?? Infinity, value);
        f.maxNumber = Math.max(f.maxNumber ?? -Infinity, value);
      } else if (typeof value === 'string') {
        f.shapes.add(shapeOf(value));
      }
    });
  }
  return { runs: history.length, fields };
}

/**
 * Check one run's outputs against the envelope of `history`. Returns
 * `insufficient_history` when there are fewer than `MIN_ENVELOPE_RUNS`
 * history runs.
 */
export function checkEnvelope(
  history: readonly unknown[][],
  outputs: unknown[],
  tolerance: ToleranceMap = {},
): EnvelopeResult {
  if (history.length < MIN_ENVELOPE_RUNS) {
    return { status: 'insufficient_history', runs: history.length };
  }
  const envelope = learnEnvelope(history, tolerance);
  const deviations = new Map<string, EnvelopeDeviation>();
  const add = (path: string, check: EnvelopeCheck, message: string) => {
    const key = `${path}\u0000${check}`;
    if (!deviations.has(key)) deviations.set(key, { path, check, message });
  };
  const runs = envelope.runs;

  const present = new Set<string>();
  visit(outputs, '', '', (field, _concrete, value) => {
    present.add(field);
    const f = envelope.fields.get(field);
    if (f === undefined) {
      add(
        field,
        'unexpected',
        `${field} appears, but none of the last ${runs} passing runs produced it.`,
      );
      return;
    }
    const type = typeOf(value);
    if (!f.types.has(type)) {
      add(
        field,
        'type',
        `${field} is a ${type}, which it never was in the last ${runs} passing runs.`,
      );
      return;
    }
    if (Array.isArray(value) && f.minLength !== undefined && f.maxLength !== undefined) {
      const low = Math.floor(f.minLength / 2);
      const high = f.maxLength * 2 + 2;
      if (value.length < low || value.length > high) {
        add(
          field,
          'length',
          `${field} has ${value.length < low ? 'far fewer' : 'far more'} items than in any of the last ${runs} passing runs.`,
        );
      }
    } else if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      !f.tolerated &&
      f.minNumber !== undefined &&
      f.maxNumber !== undefined
    ) {
      const spread = f.maxNumber - f.minNumber;
      const widen = Math.max(
        spread,
        0.5 * Math.max(Math.abs(f.minNumber), Math.abs(f.maxNumber)),
        1,
      );
      if (value < f.minNumber - widen || value > f.maxNumber + widen) {
        add(field, 'range', `${field} is well outside the range of the last ${runs} passing runs.`);
      }
    } else if (typeof value === 'string' && f.shapes.size > 0 && f.shapes.size <= MAX_SHAPES) {
      if (!f.shapes.has(shapeOf(value))) {
        add(
          field,
          'shape',
          `${field} has a different form (letters, digits, punctuation) from every value in the last ${runs} passing runs.`,
        );
      }
    }
  });

  for (const [field, f] of envelope.fields) {
    if (f.presentIn === runs && !present.has(field) && !coveredByMissingParent(field, present)) {
      add(
        field,
        'missing',
        `${field} is missing, though all of the last ${runs} passing runs produced it.`,
      );
    }
  }

  const list = [...deviations.values()];
  return list.length === 0
    ? { status: 'within', runs }
    : { status: 'outside', runs, deviations: list };
}

function newField(): FieldEnvelope {
  return { types: new Set(), presentIn: 0, shapes: new Set(), tolerated: false };
}

/**
 * Call `fn` for every value in `value`, with its field path (array
 * positions as `*`) and its concrete path (positions as numbers, the form
 * tolerance patterns are written against). The root itself is skipped.
 */
function visit(
  value: unknown,
  field: string,
  concrete: string,
  fn: (field: string, concrete: string, value: unknown) => void,
): void {
  if (field !== '' || concrete !== '') fn(field, concrete, value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => visit(item, join(field, '*'), join(concrete, String(i)), fn));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      visit(item, join(field, key), join(concrete, key), fn);
    }
  }
}

/**
 * A field inside an array that is empty now is not "missing" in its own
 * right: the array's length is the deviation (or a legitimate empty table).
 */
function coveredByMissingParent(field: string, present: Set<string>): boolean {
  const segments = field.split('.');
  for (let i = segments.length - 1; i > 0; i--) {
    const parent = segments.slice(0, i).join('.');
    if (present.has(parent)) return segments[i] === '*';
  }
  return false;
}

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean' ? t : 'object';
}

/**
 * A string's shape: runs of letters become `a`, runs of digits `9`, runs
 * of whitespace one space; everything else is kept. Unicode letters and
 * digits count, so the shape does not depend on the language of the site.
 */
export function shapeOf(text: string): string {
  return text
    .trim()
    .replace(/\p{L}+/gu, 'a')
    .replace(/\p{Nd}+/gu, '9')
    .replace(/\s+/g, ' ');
}

function join(a: string, b: string): string {
  return a === '' ? b : `${a}.${b}`;
}
