// Pure tests for the drift report: no browser, so they run in the root
// baseline (the `.unit.test.ts` suffix is what the root config picks up).

import { describe, expect, it } from 'vitest';
import type { CaseRunResult } from './heal-run.js';
import {
  buildReport,
  CASE_FALSE_HEAL_FORMULA,
  FALSE_HEAL_FORMULA,
  renderReport,
  wilson,
} from './report.js';
import type { DriftResultsFile } from './report.js';
import { FROZEN_SUITES } from './suites.js';
import type { FrozenSuite } from './suites.js';

type Expect = CaseRunResult['expect'];

const NO_USAGE = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0 };

function run(
  caseId: string,
  expect: Expect,
  outcome: CaseRunResult['outcome'],
  options: {
    group?: CaseRunResult['group'];
    verdict?: 'correct' | 'false_heal';
    score?: number;
    runNo?: number;
    calls?: number;
    costUsd?: number;
  } = {},
): CaseRunResult {
  const decided = outcome === 'healed' || outcome === 'partial' || outcome === 'max_heals';
  const judgement = options.verdict ? { verdict: options.verdict, reasons: [] } : undefined;
  return {
    caseId,
    fixture: 'portal',
    group: options.group ?? 'single',
    expect,
    run: options.runNo ?? 1,
    initial: { status: outcome === 'not_invoked' ? 'passed' : 'failed' },
    outcome,
    heals: decided
      ? [
          {
            index: 0,
            trigger: 'failure',
            status: 'decided',
            attempts: [],
            patchClass: 'selector',
            decision: 'awaiting_approval',
            oracleAgrees: true,
            ...(options.score !== undefined ? { score: options.score } : {}),
            ...(judgement ? { judgement } : {}),
          },
        ]
      : outcome === 'not_invoked'
        ? []
        : [{ index: 0, trigger: 'failure', status: 'not_healed', attempts: [] }],
    ...(judgement ? { judgement } : {}),
    usage: {
      ...NO_USAGE,
      calls: options.calls ?? 0,
      inputTokens: (options.calls ?? 0) * 1000,
      costUsd: options.costUsd ?? 0,
    },
    durationMs: 1,
  } as CaseRunResult;
}

const selector: Expect = { effect: 'fails', step: 'click_002', heal: 'selector' };
const trap: Expect = { ...selector, trap: true };
const removed: Expect = { effect: 'fails', step: 'click_002', heal: 'not_healable' };
const gap: Expect = { ...removed, gap: 'iframe' };
const robust: Expect = { effect: 'none', heal: 'none' };
const silent: Expect = { effect: 'silent', heal: 'none' };

function file(results: CaseRunResult[], over: Partial<DriftResultsFile> = {}): DriftResultsFile {
  return {
    suite: { cases: 6, selected: 6, casesSha256: 'abc' },
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    prices: { 'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 } },
    budget: { maxUsd: 1 },
    runsPerCase: 3,
    policy: 'human',
    judge: 'same elements, same outputs',
    dryRun: false,
    startedAt: '2026-11-20T00:00:00.000Z',
    finishedAt: '2026-11-20T01:00:00.000Z',
    usage: { calls: 4, inputTokens: 4000, outputTokens: 0, costUsd: 0.04, unpricedCalls: 0 },
    results,
    ...over,
  };
}

// A held-out suite matching the sample's hash, so the headline tests do not
// depend on the real frozen suites.
const HELD: FrozenSuite = {
  name: 'held-out h1',
  role: 'held_out',
  frozenOn: '2026-11-22',
  cases: 6,
  casesFile: 'cases.ts',
  casesSha256: 'abc',
  casesDataSha256: 'abcdata',
  files: {},
};
const OPTS = { suiteVersion: 'held-out h1', suites: [HELD] };

const SAMPLE = [
  run('a', selector, 'healed', { verdict: 'correct', score: 0.9, calls: 1, costUsd: 0.01 }),
  run('a', selector, 'healed', {
    verdict: 'correct',
    score: 0.85,
    runNo: 2,
    calls: 1,
    costUsd: 0.01,
  }),
  run('b', trap, 'healed', { verdict: 'false_heal', score: 0.6, calls: 1, costUsd: 0.01 }),
  run('b', trap, 'not_healed', { runNo: 2, calls: 1, costUsd: 0.01 }),
  run('c', selector, 'partial', { group: 'complex', verdict: 'correct', score: 0.7 }),
  run('d', gap, 'not_healed'),
  run('e', removed, 'healed', { verdict: 'false_heal', score: 0.5 }),
  run('f', robust, 'not_invoked'),
  run('g', silent, 'not_invoked'),
  run('g', silent, 'healed', { runNo: 2, verdict: 'correct' }),
];

describe('wilson()', () => {
  it('matches known values', () => {
    const half = wilson(5, 10)!;
    expect(half.value).toBe(0.5);
    expect(half.low).toBeCloseTo(0.2366, 4);
    expect(half.high).toBeCloseTo(0.7634, 4);
  });

  it('gives a real upper bound at zero and stays inside 0 to 1', () => {
    const none = wilson(0, 10)!;
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.2775, 4);
    const all = wilson(10, 10)!;
    expect(all.high).toBe(1);
    expect(all.low).toBeCloseTo(0.7225, 4);
  });

  it('is null with no trials', () => {
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('buildReport(): heal quality', () => {
  const report = buildReport(file(SAMPLE), OPTS);
  const row = (label: string) => report.quality.find((q) => q.label.startsWith(label))!;

  it('splits healable runs by group and keeps the decoy row separate', () => {
    expect(report.quality.map((q) => q.label)).toEqual([
      'Single changes',
      'Complex changes',
      'Decoy traps (also counted above)',
      'All healable',
    ]);
    expect(row('Single')).toMatchObject({
      cases: 2,
      runs: 4,
      verified: 3,
      correct: 2,
      falseHeals: 1,
    });
    expect(row('Decoy')).toMatchObject({
      cases: 1,
      runs: 2,
      verified: 1,
      correct: 0,
      falseHeals: 1,
    });
    expect(row('All')).toMatchObject({ cases: 3, runs: 5, verified: 4, correct: 2, falseHeals: 1 });
  });

  it('divides false heals by verified runs and correct runs by all runs', () => {
    expect(row('All').falseHealRate).toMatchObject({ numerator: 1, denominator: 4 });
    expect(row('All').healRate).toMatchObject({ numerator: 2, denominator: 5 });
  });

  it('also counts false heals by case, over cases verified in any run', () => {
    // a verified twice, b once (a false heal), c once: 3 cases, 1 false.
    expect(row('All')).toMatchObject({ casesVerified: 3, casesWithFalseHeal: 1 });
    expect(row('All').caseFalseHealRate).toMatchObject({ numerator: 1, denominator: 3 });
    expect(row('Decoy')).toMatchObject({ casesVerified: 1, casesWithFalseHeal: 1 });
  });

  it('counts a case once however many of its runs were verified or false', () => {
    const repeated = buildReport(
      file([
        run('x', selector, 'healed', { verdict: 'false_heal' }),
        run('x', selector, 'healed', { verdict: 'false_heal', runNo: 2 }),
        run('x', selector, 'not_healed', { runNo: 3 }),
        run('y', selector, 'not_healed'),
        run('y', selector, 'healed', { verdict: 'correct', runNo: 2 }),
      ]),
      OPTS,
    );
    const all = repeated.quality.find((q) => q.label === 'All healable')!;
    expect(all).toMatchObject({ verified: 3, falseHeals: 2 });
    expect(all.falseHealRate).toMatchObject({ numerator: 2, denominator: 3 });
    expect(all.caseFalseHealRate).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it('gives no by-case rate when nothing was verified', () => {
    const none = buildReport(file([run('x', selector, 'not_healed')]), OPTS);
    const all = none.quality.find((q) => q.label === 'All healable')!;
    expect(all).toMatchObject({ casesVerified: 0, casesWithFalseHeal: 0, caseFalseHealRate: null });
  });

  it('does not count an unfinished heal as correct', () => {
    // Case c ended partial with a correct judgement: verified, not correct.
    expect(row('Complex')).toMatchObject({ runs: 1, verified: 1, correct: 0, falseHeals: 0 });
  });

  it('shows the decoy row even when there are no decoys', () => {
    const plain = buildReport(file([SAMPLE[0]!]), { suiteVersion: 'v1' });
    const decoys = plain.quality.find((q) => q.label.startsWith('Decoy'))!;
    expect(decoys).toMatchObject({ runs: 0, falseHealRate: null, healRate: null });
  });
});

describe('buildReport(): refusals and never-reached', () => {
  const report = buildReport(file(SAMPLE), OPTS);

  it('counts refusals, names gaps, and lists a patch made on an unhealable case', () => {
    expect(report.refusals).toMatchObject({ runs: 2, refused: 1 });
    expect(report.refusals.wrongPatches).toEqual([{ caseId: 'e', run: 1, verdict: 'false_heal' }]);
    expect(report.refusals.gaps).toEqual([{ caseId: 'd', gap: 'iframe', runs: 1, refused: 1 }]);
    expect(report.refusals.removed).toEqual([{ caseId: 'e', runs: 1, refused: 0 }]);
  });

  it('keeps cases that should never reach the healer out of the rates, and names any that did', () => {
    expect(report.neverReached.robust).toEqual({ runs: 1, reached: [] });
    expect(report.neverReached.silent).toEqual({ runs: 2, reached: ['g (run 2)'] });
    expect(report.quality.find((q) => q.label === 'All healable')!.runs).toBe(5);
  });
});

describe('buildReport(): supporting numbers', () => {
  const report = buildReport(file(SAMPLE), OPTS);

  it('bands decided heals by score at 0.5 and 0.8', () => {
    expect(report.supporting.scoreBands).toEqual([
      { label: 'below 0.5', correct: 0, falseHeals: 0 },
      { label: '0.5 to under 0.8', correct: 1, falseHeals: 2 },
      { label: '0.8 and above', correct: 2, falseHeals: 0 },
    ]);
  });

  it('reports cost over runs that called the model, and per correct heal', () => {
    expect(report.supporting.cost).toMatchObject({
      calls: 4,
      usd: 0.04,
      runsWithModelCalls: 4,
      tokensPerRun: { median: 1000, p90: 1000 },
      usdPerRun: { median: 0.01, p90: 0.01 },
      usdPerCorrectRun: 0.02,
    });
  });

  it('leaves cost out when a call had no price', () => {
    const unpriced = buildReport(
      file(SAMPLE, { usage: { ...NO_USAGE, calls: 4, unpricedCalls: 4 } }),
      { suiteVersion: 'v1' },
    );
    expect(unpriced.supporting.cost).toMatchObject({
      usd: null,
      usdPerRun: null,
      usdPerCorrectRun: null,
    });
    expect(unpriced.warnings.join(' ')).toContain('no price');
  });
});

describe('buildReport(): warnings and headline', () => {
  it('gives a headline only when nothing rules it out', () => {
    const report = buildReport(file(SAMPLE), OPTS);
    expect(report.warnings).toEqual([]);
    expect(report.headline).toContain('On held-out h1 (3 healable cases, 3 runs each');
    expect(report.headline).toContain('false-heal rate of 25.0%');
    expect(report.headline).toContain('by case, 1 of 3, 95% CI 6.1% to 79.2%');
    expect(report.headline).toContain('1 false heal(s) in 2 run(s)');
  });

  it.each<[string, Partial<DriftResultsFile>, { suiteVersion?: string }, string]>([
    ['a dry run', { dryRun: true }, { suiteVersion: 'v1' }, 'Dry run'],
    [
      'a partial suite',
      { suite: { cases: 69, selected: 5, casesSha256: 'x' } },
      { suiteVersion: 'v1' },
      'Partial suite',
    ],
    ['no suite version', {}, {}, 'No suite version'],
    ['one run per case', { runsPerCase: 1 }, { suiteVersion: 'v1' }, 'at least 3'],
  ])('withholds the headline for %s', (_, over, options, warning) => {
    const report = buildReport(file(SAMPLE, over), options);
    expect(report.headline).toBeNull();
    expect(report.warnings.join(' ')).toContain(warning);
  });

  it('withholds the headline for a run stopped on a provider failure', () => {
    const aborted = { caseId: 'c1', run: 1, code: 'auth', message: 'invalid x-api-key' };
    const report = buildReport(file(SAMPLE, { aborted }), OPTS);
    expect(report.headline).toBeNull();
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('Stopped early');
    expect(report.warnings[0]).toContain('"auth"');
  });
});

describe('buildReport(): frozen suites', () => {
  const v1 = FROZEN_SUITES.find((s) => s.name === 'drift-suite v1')!;
  const onV1 = { suite: { cases: 69, selected: 69, casesSha256: v1.casesSha256 } };

  it('finds the suite from the cases hash and labels the tuning set', () => {
    const report = buildReport(file(SAMPLE, onV1));
    expect(report.header.suiteVersion).toBe('drift-suite v1');
    expect(report.header.suiteRole).toBe('tuning');
    expect(report.headline).toBeNull();
    expect(report.warnings.join(' ')).toContain('drift-suite v1 is the tuning set');
    expect(renderReport(report)).toContain('- Suite: drift-suite v1 (tuning set), 69 of 69');
  });

  it('refuses a suite name the results were not run on', () => {
    const report = buildReport(file(SAMPLE), { suiteVersion: 'drift-suite v1' });
    expect(report.header.suiteRole).toBeNull();
    expect(report.headline).toBeNull();
    expect(report.warnings.join(' ')).toContain('These results were not run on drift-suite v1');
  });

  it('refuses a suite name that is not frozen', () => {
    const report = buildReport(file(SAMPLE), { suiteVersion: 'drift-suite v9' });
    expect(report.headline).toBeNull();
    expect(report.warnings.join(' ')).toContain('"drift-suite v9" is not a frozen suite');
  });

  it('labels a matching held-out suite and gives it the headline', () => {
    const report = buildReport(file(SAMPLE), { suites: [HELD] });
    expect(report.header.suiteVersion).toBe('held-out h1');
    expect(report.header.suiteRole).toBe('held_out');
    expect(report.headline).not.toBeNull();
    expect(renderReport(report)).toContain('- Suite: held-out h1 (held-out set)');
  });
});

describe('renderReport()', () => {
  it('states the formula, shows every table, and writes no dashes the style rules forbid', () => {
    const text = renderReport(buildReport(file(SAMPLE), OPTS));
    expect(text).toContain(FALSE_HEAL_FORMULA);
    expect(text).toContain(CASE_FALSE_HEAL_FORMULA);
    expect(text).toContain('| False-heal rate by case (95% CI) |');
    expect(text).toContain('| 1 of 3: 33.3% (6.1% to 79.2%) |');
    for (const heading of [
      '## Heal quality',
      '## Refusals',
      '## Never meant to reach the healer',
      '## Supporting numbers',
      '## Per case',
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain('| Decoy traps (also counted above) | 1 | 2 |');
    expect(text).toContain('| d | iframe | 1 | 1 |');
    expect(text).not.toMatch(/[–—]/);
  });

  it('puts the warnings first when the numbers are not fit to publish', () => {
    const text = renderReport(buildReport(file(SAMPLE, { dryRun: true })));
    expect(text.indexOf('Not for publication')).toBeLessThan(text.indexOf('## Run'));
    expect(text).not.toContain('## Headline');
  });
});
