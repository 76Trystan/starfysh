// What a drift case can be outside the frozen v1 suite, and the helpers
// for writing one.
//
// `cases.ts` is frozen as drift-suite v1 (see `suites.ts`), and its
// `DriftCase` type only names the two v1 fixtures. Widening it there would
// change the file's hash and unfreeze v1, so the wider type lives here, and
// the harness (`heal-run.ts`, `run.ts`, `case-sets.ts`) uses it. A v1 case
// is a `SuiteCase` as it stands.
//
// The helpers below are copies of the ones in `cases.ts`, for the same
// reason: they are not exported there, and exporting them would be an edit
// to a frozen file. They must build exactly what the v1 helpers build, so
// a case written with either reads the same to the harness.
//
// This file is shared and not frozen, but what a frozen suite's cases
// build from it is: `suites.unit.test.ts` hashes every frozen suite's
// built cases (`casesDataHash` in `suites.ts`). Adding a fixture name or a
// new helper is fine. Changing what an existing helper returns fails that
// test if any frozen suite uses it; give the next set a new helper instead.

import type { Condition, SelectorCandidate } from '@sfysh/ir';
import type { DriftCase, DriftEffect, DriftGroup } from './cases.js';
import type { Drift } from './drift.js';
import type { OraclePatch } from './oracle.js';

/** Every fixture in `fixtures/`. v1 uses `portal` and `shop`. */
export type FixtureName = 'portal' | 'shop' | 'bank';

/** A drift case on any fixture. */
export type SuiteCase = Omit<DriftCase, 'fixture'> & { fixture: FixtureName };

/** Where a step's element is, by its truth marker. */
export const at = (step: string) => `[data-sfysh-truth="${step}"]`;

// Drift operators.
export const rename = (selector: string, text: string): Drift => ({
  op: 'rename_text',
  selector,
  text,
});
export const setAttr = (selector: string, name: string, value: string): Drift => ({
  op: 'set_attribute',
  selector,
  name,
  value,
});
export const dropAttr = (selector: string, name: string): Drift => ({
  op: 'remove_attribute',
  selector,
  name,
});
export const retag = (selector: string, tag: string): Drift => ({ op: 'retag', selector, tag });
export const reorderColumns = (table: string, order: number[]): Drift => ({
  op: 'reorder_columns',
  table,
  order,
});
export const menu = (selector: string, menuLabel: string): Drift => ({
  op: 'wrap_in_menu',
  selector,
  menuLabel,
});
export const banner = (text: string, dismissLabel: string): Drift => ({
  op: 'add_overlay',
  text,
  dismissLabel,
});
export const decoy = (
  selector: string,
  text: string,
  position: 'before' | 'after' = 'before',
): Drift => ({ op: 'add_decoy', selector, text, position });
export const remove = (selector: string): Drift => ({ op: 'remove', selector });
export const onLoads = (loads: number[], drifts: Drift[]): Drift => ({
  op: 'on_loads',
  loads,
  drifts,
});
export const shadow = (selector: string): Drift => ({ op: 'shadow', selector });
export const iframe = (selector: string, title: string): Drift => ({
  op: 'iframe',
  selector,
  title,
});
export const delay = (selector: string, ms: number): Drift => ({ op: 'delay', selector, ms });

// Selector candidates.
export const role = (value: string): SelectorCandidate => ({ kind: 'role', value });
export const testid = (value: string): SelectorCandidate => ({ kind: 'testid', value });
export const label = (value: string): SelectorCandidate => ({ kind: 'label', value });
export const text = (value: string): SelectorCandidate => ({ kind: 'text', value });
export const css = (value: string): SelectorCandidate => ({ kind: 'css', value });

// Oracle patches.
export const reselect = (stepId: string, ...candidates: SelectorCandidate[]): OraclePatch => ({
  kind: 'reselect',
  stepId,
  candidates,
});
export const promote = (stepId: string, index = 1): OraclePatch => ({
  kind: 'promote',
  stepId,
  index,
});
export const clickFirst = (
  beforeStepId: string,
  target: SelectorCandidate,
  intent: string,
): OraclePatch => ({ kind: 'insert_click', beforeStepId, target, intent });
export const waitFirst = (beforeStepId: string, until: Condition, intent: string): OraclePatch => ({
  kind: 'insert_wait',
  beforeStepId,
  until,
  intent,
});

export type Row = [
  id: string,
  description: string,
  drifts: Drift[],
  expect: SuiteCase['expect'],
  oracle?: OraclePatch[],
];

/**
 * Build a fixture's cases, as `cases.ts` does for v1. A `simple` row's
 * group follows from its effect: a change the workflow survives is
 * `robustness`, a silent breakage is `silent`, anything else is a `single`
 * change. Every `complex` row is `complex`, whatever its effect.
 */
export function cases(fixture: FixtureName, kind: 'simple' | 'complex', rows: Row[]): SuiteCase[] {
  return rows.map(([id, description, drifts, expect, oracle]) => ({
    id: `${fixture}-${id}`,
    description,
    fixture,
    group: kind === 'complex' ? 'complex' : groupOf(expect.effect),
    drifts,
    expect,
    ...(oracle !== undefined ? { oracle } : {}),
  }));
}

function groupOf(effect: DriftEffect): DriftGroup {
  return effect === 'none' ? 'robustness' : effect === 'silent' ? 'silent' : 'single';
}
