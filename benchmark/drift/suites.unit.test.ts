// A frozen suite's files, and the cases they build, must not change. If
// this test fails, the edit belongs in the next suite version, not in a
// frozen one: revert it, and put the new or changed cases in a new cases
// file with its own entry in `suites.ts`. If the built-cases test fails
// while every file test passes, the change came from a shared helper
// (`case-kit.ts`): revert it there, or give the next set its own helper.
// See the header of `suites.ts` for why.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASE_SETS } from './case-sets.js';
import { ALL_CASES } from './cases.js';
import { casesDataHash, FROZEN_SUITES, suiteByCasesHash, suiteByName } from './suites.js';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (path: string) =>
  createHash('sha256')
    .update(readFileSync(join(here, path), 'utf8'))
    .digest('hex');

describe('frozen drift suites', () => {
  it.each(FROZEN_SUITES.flatMap((s) => Object.keys(s.files).map((path) => [s.name, path])))(
    '%s: %s is unchanged',
    (name, path) => {
      const suite = suiteByName(name)!;
      expect(sha256(path), `${path} is frozen in ${name}`).toBe(suite.files[path]);
    },
  );

  it.each(FROZEN_SUITES.map((s) => [s.name, s.casesFile]))(
    '%s: the cases %s builds are unchanged',
    (name, casesFile) => {
      const suite = suiteByName(name)!;
      const set = CASE_SETS.find((s) => s.file === casesFile);
      expect(set, `no case set reads ${casesFile}`).toBeDefined();
      expect(set!.cases.length).toBe(suite.cases);
      expect(casesDataHash(set!.cases), `the cases built from ${casesFile} changed`).toBe(
        suite.casesDataSha256,
      );
    },
  );

  it('records the cases-file hash the way heal:drift does', () => {
    for (const suite of FROZEN_SUITES) {
      expect(suite.files[suite.casesFile]).toBe(suite.casesSha256);
    }
  });

  it('v1 is the 69-case tuning set', () => {
    const v1 = suiteByName('drift-suite v1')!;
    expect(v1.role).toBe('tuning');
    expect(v1.cases).toBe(ALL_CASES.length);
    expect(suiteByCasesHash(v1.casesSha256)).toBe(v1);
  });

  it('gives every suite a unique name and hash', () => {
    expect(new Set(FROZEN_SUITES.map((s) => s.name)).size).toBe(FROZEN_SUITES.length);
    expect(new Set(FROZEN_SUITES.map((s) => s.casesSha256)).size).toBe(FROZEN_SUITES.length);
  });
});

describe('casesDataHash', () => {
  it('ignores key order and undefined fields', () => {
    expect(casesDataHash([{ a: 1, b: { c: 2, d: 3 } }])).toBe(
      casesDataHash([{ b: { d: 3, c: 2 }, a: 1, e: undefined }]),
    );
  });

  it('changes when a nested value changes', () => {
    expect(casesDataHash([{ drifts: [{ op: 'rename_text', text: 'A' }] }])).not.toBe(
      casesDataHash([{ drifts: [{ op: 'rename_text', text: 'B' }] }]),
    );
  });

  it('keeps array order', () => {
    expect(casesDataHash([{ id: 'a' }, { id: 'b' }])).not.toBe(
      casesDataHash([{ id: 'b' }, { id: 'a' }]),
    );
  });

  it('refuses a case that is not plain data', () => {
    expect(() => casesDataHash([{ build: () => 1 }])).toThrow('plain JSON data');
  });
});
