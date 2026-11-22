// Case sets: the cases files `heal:drift` can run, and the rule for when a
// model may run on one.
//
// A case set is a cases file and the cases it exports. A frozen suite
// (`suites.ts`) is a case set whose files are fixed by hash. The two are
// kept apart because a held-out set exists, and is run with the oracle
// provider for its self-check, before it is frozen.
//
// The rule: a set meant to be held out may not meet a model until it is
// frozen as a `held_out` suite. Otherwise its cases could be written, or
// rewritten, with a model's result in view, and the held-out number would
// be tuned like the rest.

import { ALL_CASES } from './cases.js';
import type { DriftCase } from './cases.js';
import { suiteByCasesHash } from './suites.js';
import type { FrozenSuite, SuiteRole } from './suites.js';

export interface CaseSet {
  /** The name given to `heal:drift --cases`. */
  name: string;
  /** The cases file, relative to this folder. Its sha256 goes into results.json. */
  file: string;
  /** What the set is for once frozen. */
  role: SuiteRole;
  cases: readonly DriftCase[];
}

export const CASE_SETS: readonly CaseSet[] = [
  { name: 'v1', file: 'cases.ts', role: 'tuning', cases: ALL_CASES },
];

/** The set `heal:drift` runs when `--cases` is not given. */
export const DEFAULT_CASE_SET = 'v1';

export function caseSetByName(name: string, sets: readonly CaseSet[] = CASE_SETS) {
  return sets.find((s) => s.name === name);
}

/**
 * Why `heal:drift` may not run a model on this set, or null when it may.
 * `casesSha256` is the hash of the set's file as it is on disk now.
 */
export function modelRunRefusal(
  set: CaseSet,
  casesSha256: string,
  suites?: readonly FrozenSuite[],
): string | null {
  if (set.role !== 'held_out') return null;
  const frozen = suiteByCasesHash(casesSha256, suites);
  if (frozen?.role === 'held_out') return null;
  return (
    `Case set "${set.name}" is meant to be held out and ${set.file} is not frozen as a held-out suite. ` +
    'No model may run on it before it is frozen in suites.ts; use --provider oracle to check the harness.'
  );
}
