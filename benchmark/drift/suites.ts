// Frozen drift suites: which versions of the suite a published number may
// name, and what each one is for.
//
// A suite is frozen by the sha256 of `cases.ts` (the hash `heal:drift`
// writes into every results.json) and of the fixture files its cases run
// on. Once a suite is listed here its files do not change: a new case, a
// reworded oracle or an edited fixture goes into the next version, so a
// rate measured on v1 today means the same thing as one measured on v1
// next month. `suites.unit.test.ts` fails if a frozen file changes.
//
// The drift operators (`page-drift.js`, `drift.ts`) and the healer are not
// frozen: they are the code under test, and a bug fix there is measured,
// not hidden.
//
// Roles:
// - `tuning`: the prompt or scorer has been changed because of what these
//   cases showed, so their rates are partly fitted to them. Reported beside
//   the headline, labelled as such, never as the headline.
// - `held_out`: nothing is ever tuned against these cases. The published
//   headline comes from a held-out suite. Any prompt change after a held-out
//   suite exists means a new held-out suite for the next version.

export type SuiteRole = 'tuning' | 'held_out';

export interface FrozenSuite {
  /** The name a report prints, for example `drift-suite v1`. */
  name: string;
  role: SuiteRole;
  /** The date the suite was frozen, YYYY-MM-DD. */
  frozenOn: string;
  /** Number of cases in the suite. */
  cases: number;
  /** sha256 of the cases file, as `heal:drift` records it. */
  casesSha256: string;
  /** sha256 of every file the cases read, keyed by path relative to this folder. */
  files: Record<string, string>;
}

export const FROZEN_SUITES: readonly FrozenSuite[] = [
  {
    name: 'drift-suite v1',
    role: 'tuning',
    frozenOn: '2026-11-22',
    cases: 69,
    casesSha256: '1821387f637e92f671c795df7551012f5c316a6a46398a91e990e3217efd4684',
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
];

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
