// A frozen suite's files must not change. If this test fails, the edit
// belongs in the next suite version, not in a frozen one: revert it, and
// put the new or changed cases in a new cases file with its own entry in
// `suites.ts`. See the header of `suites.ts` for why.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_CASES } from './cases.js';
import { FROZEN_SUITES, suiteByCasesHash, suiteByName } from './suites.js';

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
