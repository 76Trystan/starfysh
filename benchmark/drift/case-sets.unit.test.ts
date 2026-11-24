import { describe, expect, it } from 'vitest';
import { CASE_SETS, caseSetByName, DEFAULT_CASE_SET, modelRunRefusal } from './case-sets.js';
import type { CaseSet } from './case-sets.js';
import { ALL_CASES } from './cases.js';
import { FROZEN_SUITES } from './suites.js';
import type { FrozenSuite } from './suites.js';

const heldOut: CaseSet = { name: 'h1', file: 'cases-h1.ts', role: 'held_out', cases: [] };
const frozen = (role: FrozenSuite['role']): FrozenSuite => ({
  name: 'drift-suite h1',
  role,
  frozenOn: '2026-11-22',
  cases: 0,
  casesFile: 'cases-h1.ts',
  casesSha256: 'h1hash',
  casesDataSha256: 'h1data',
  files: {},
});

describe('case sets', () => {
  it('runs v1 from cases.ts by default', () => {
    const v1 = caseSetByName(DEFAULT_CASE_SET)!;
    expect(v1).toMatchObject({ name: 'v1', file: 'cases.ts', role: 'tuning' });
    expect(v1.cases).toBe(ALL_CASES);
  });

  it('gives every set a unique name and file', () => {
    expect(new Set(CASE_SETS.map((s) => s.name)).size).toBe(CASE_SETS.length);
    expect(new Set(CASE_SETS.map((s) => s.file)).size).toBe(CASE_SETS.length);
  });

  it('lets a model run on the tuning set', () => {
    const v1 = caseSetByName('v1')!;
    expect(modelRunRefusal(v1, FROZEN_SUITES[0]!.casesSha256)).toBeNull();
  });

  it('refuses a model on a held-out set that is not frozen', () => {
    expect(modelRunRefusal(heldOut, 'h1hash', [])).toContain('is not frozen as a held-out suite');
  });

  it('refuses a model when the held-out file changed after it was frozen', () => {
    expect(modelRunRefusal(heldOut, 'edited', [frozen('held_out')])).not.toBeNull();
  });

  it('refuses a model when the hash is frozen only as a tuning suite', () => {
    expect(modelRunRefusal(heldOut, 'h1hash', [frozen('tuning')])).not.toBeNull();
  });

  it('lets a model run on a held-out set once it is frozen', () => {
    expect(modelRunRefusal(heldOut, 'h1hash', [frozen('held_out')])).toBeNull();
  });

  it('lets a model run on h1 as frozen in suites.ts', () => {
    const h1 = caseSetByName('h1')!;
    const suite = FROZEN_SUITES.find((s) => s.name === 'drift-suite h1')!;
    expect(suite.casesFile).toBe(h1.file);
    expect(modelRunRefusal(h1, suite.casesSha256)).toBeNull();
  });
});
