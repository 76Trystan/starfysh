// Frozen drift suites: which versions of the suite a published number may
// name, and what each one is for.
//
// A suite is frozen by the sha256 of its cases file (`cases.ts` for v1;
// the hash `heal:drift` writes into every results.json) and of the fixture
// files its cases run on. Once a suite is listed here its files do not change: a new case, a
// reworded oracle or an edited fixture goes into the next version, so a
// rate measured on v1 today means the same thing as one measured on v1
// next month. `suites.unit.test.ts` fails if a frozen file changes.
//
// A suite is also frozen by the sha256 of its built cases: the case array
// the cases file exports, as canonical JSON (`casesDataHash`). The file
// hash alone misses a change made elsewhere: cases after v1 are written
// with the helpers in `case-kit.ts`, and an edit there (to how a row's
// group is worked out, say) changes what a frozen suite's cases are
// without touching its file. The helper file itself is not hashed, since
// harmless edits to it (a new fixture name, a new helper) must stay
// possible; only a change to what a frozen suite's cases build fails.
//
// The drift operators (`page-drift.js`, `drift.ts`) and the healer are not
// frozen: they are the code under test, and a bug fix there is measured,
// not hidden. If an operator change alters what a case does, the browser
// self-tests (`drift.test.ts`) fail, since they hold every case to its
// claimed effect.
//
// Roles:
// - `tuning`: the prompt or scorer has been changed because of what these
//   cases showed, so their rates are partly fitted to them. Reported beside
//   the headline, labelled as such, never as the headline.
// - `held_out`: nothing is ever tuned against these cases. The published
//   headline comes from a held-out suite. Any prompt change after a held-out
//   suite exists means a new held-out suite for the next version.

import { createHash } from 'node:crypto';

export type SuiteRole = 'tuning' | 'held_out';

export interface FrozenSuite {
  /** The name a report prints, for example `drift-suite v1`. */
  name: string;
  role: SuiteRole;
  /** The date the suite was frozen, YYYY-MM-DD. */
  frozenOn: string;
  /** Number of cases in the suite. */
  cases: number;
  /** The cases file, relative to this folder. Also a key of `files`. */
  casesFile: string;
  /** sha256 of the cases file, as `heal:drift` records it. */
  casesSha256: string;
  /** sha256 of the built cases as canonical JSON (`casesDataHash`). */
  casesDataSha256: string;
  /** sha256 of every file the cases read, keyed by path relative to this folder. */
  files: Record<string, string>;
}

export const FROZEN_SUITES: readonly FrozenSuite[] = [
  {
    name: 'drift-suite v1',
    role: 'tuning',
    frozenOn: '2026-11-22',
    cases: 69,
    casesFile: 'cases.ts',
    casesSha256: '1821387f637e92f671c795df7551012f5c316a6a46398a91e990e3217efd4684',
    casesDataSha256: '65eef647e5dfd27e422c6739815d59c1d208d5b11b54f2d77f2819d0695da954',
    files: {
      'cases.ts': '1821387f637e92f671c795df7551012f5c316a6a46398a91e990e3217efd4684',
      'fixtures/portal.html': '4720f6f9b6e4e59e011a2aafa222f53ffff96c8fab626b6616459869734aba59',
      'fixtures/portal.workflow.json':
        '7ca5dfad9570c90992fb394745df5985d1f085c357f66d2332d19383cf480aaa',
      'fixtures/shop.html': '976a446475fcff19533c9c14a113b358280f7f18a7b86fab21151734c5761563',
      'fixtures/shop.workflow.json':
        '78d07ef86c6db544593d422f26b09f8ca1fd6bca9aeac9721b6a9e79a1f92839',
    },
  },
  {
    name: 'drift-suite h1',
    role: 'held_out',
    frozenOn: '2026-11-24',
    cases: 42,
    casesFile: 'cases-h1.ts',
    casesSha256: '94e535761b30ce130f8d53a08b4af7fda0a59c2c7e86e0966c8aab7c4331de49',
    casesDataSha256: 'cba0d351042f1460113a97244c278666311b02627bea2e828d4290783e376f24',
    files: {
      'cases-h1.ts': '94e535761b30ce130f8d53a08b4af7fda0a59c2c7e86e0966c8aab7c4331de49',
      'fixtures/bank.html': 'a18721b65df50cd87f8ee219f18261fcb927a623a23488c8fed6628f304ec78f',
      'fixtures/bank.workflow.json':
        '5d5f70668cc0eb45aed292241bc2c765aad75462aa903eb09e07bbd4bc35af1e',
    },
  },
  {
    name: 'drift-suite h2',
    role: 'held_out',
    frozenOn: '2026-11-24',
    cases: 52,
    casesFile: 'cases-h2.ts',
    casesSha256: 'a93c409f7ebc311e45308d5aad95cb64d1a0b356c951b4aec536d5d07011db24',
    casesDataSha256: '005aadd510b3b20999f3ef805d72ebed373aa2aed3368cbc0c0a619f43db6ae6',
    files: {
      'cases-h2.ts': 'a93c409f7ebc311e45308d5aad95cb64d1a0b356c951b4aec536d5d07011db24',
      'fixtures/suppliers.html': '8b7b0380262bc40146998969ea995629c1a620b879d2fa51bebcc13bf896d33b',
      'fixtures/suppliers.workflow.json':
        '0356c6b4861e269c44010ba15956b3c27826fa1bb9f0b4494c16f415689784cd',
    },
  },
];

/**
 * sha256 of a case array as canonical JSON: object keys sorted at every
 * depth, array order kept, `undefined` fields dropped (as `JSON.stringify`
 * drops them). Two arrays that build the same cases hash the same, however
 * their source is written.
 */
export function casesDataHash(cases: readonly unknown[]): string {
  return createHash('sha256').update(canonicalJson(cases)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`casesDataHash: cases must be plain JSON data, found a ${typeof value}`);
  }
  return JSON.stringify(value);
}

export function suiteByName(
  name: string,
  suites: readonly FrozenSuite[] = FROZEN_SUITES,
): FrozenSuite | undefined {
  return suites.find((s) => s.name === name);
}

export function suiteByCasesHash(
  casesSha256: string,
  suites: readonly FrozenSuite[] = FROZEN_SUITES,
): FrozenSuite | undefined {
  return suites.find((s) => s.casesSha256 === casesSha256);
}
