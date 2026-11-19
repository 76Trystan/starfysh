// Self-tests for the drift heal harness, against a real Chromium, with the
// oracle provider standing in for a model. They prove the loop records
// what happened and that the judge's verdict reaches the corpus as a
// label, including a false heal. Run with `pnpm --filter @sfysh/benchmark
// test:drift`, like the drift module's own tests.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { MemoryCorpus } from '@sfysh/healer';
import type { CorpusRecord, LabelCorpusRecord } from '@sfysh/healer';
import { MemoryUsageLedger, MeteredProvider } from '@sfysh/providers';
import { ALL_CASES } from './cases.js';
import type { DriftCase } from './cases.js';
import { judgeProgress, loadFixture, namesTruthMarker } from './drift.js';
import type { Observation } from './drift.js';
import { loadBaseline, runDriftCase } from './heal-run.js';
import type { Baseline, CaseRunResult } from './heal-run.js';
import { OracleProvider } from './oracle-provider.js';

let browser: Browser;
let portal: Baseline;
beforeAll(async () => {
  browser = await chromium.launch();
  portal = await loadBaseline(browser, 'portal');
});
afterAll(async () => {
  await browser?.close();
});

const byId = (id: string): DriftCase => {
  const found = ALL_CASES.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

async function runWithOracle(
  driftCase: DriftCase,
): Promise<{ result: CaseRunResult; records: CorpusRecord[]; ledger: MemoryUsageLedger }> {
  const oracle = new OracleProvider();
  const ledger = new MemoryUsageLedger();
  const corpus = new MemoryCorpus();
  const result = await runDriftCase(driftCase, portal, {
    browser,
    provider: new MeteredProvider(oracle, {
      ledger,
      prices: { oracle: { inputPerMTok: 1, outputPerMTok: 1 } },
    }),
    ledger,
    corpus,
    beforeHeal: oracle.beforeHeal,
  });
  return { result, records: corpus.records, ledger };
}

const labels = (records: CorpusRecord[]) =>
  records.filter((r): r is LabelCorpusRecord => r.kind === 'label');

describe('groups', () => {
  it('tags every case, with each group present', () => {
    const groups = new Set(ALL_CASES.map((c) => c.group));
    expect(groups).toEqual(new Set(['single', 'robustness', 'silent', 'complex']));
    for (const c of ALL_CASES) {
      if (c.group === 'robustness') expect(c.expect.effect).toBe('none');
      if (c.group === 'silent') expect(c.expect.effect).toBe('silent');
    }
  });
});

describe('the judge for one heal of several', () => {
  const baseline = {
    status: 'ok',
    truth: ['click:click_002', 'fill:fill_003', 'click:click_004'],
    outputs: [{ a: 1 }, { b: 2 }],
  } as unknown as Observation;
  const failedWith = (truth: string[], outputs: unknown[] = []) =>
    ({ status: 'failed', truth, outputs }) as unknown as Observation;

  it('accepts a run that did the right things before failing further on', () => {
    expect(judgeProgress(baseline, failedWith(['click:click_002', 'click:drift:dismiss']))).toEqual(
      { verdict: 'correct', reasons: [] },
    );
  });

  it('rejects a run that touched a decoy, went off course, or emitted different outputs', () => {
    expect(judgeProgress(baseline, failedWith(['click:decoy'])).verdict).toBe('false_heal');
    expect(judgeProgress(baseline, failedWith(['fill:fill_003'])).verdict).toBe('false_heal');
    expect(judgeProgress(baseline, failedWith([], [{ a: 2 }])).verdict).toBe('false_heal');
  });

  it('flags a healed workflow that names the truth marker', () => {
    const wf = loadFixture('portal').workflow;
    const leaked = JSON.parse(
      JSON.stringify(wf).replace('nav a.nav-orders', '[data-sfysh-truth=\\"click_002\\"]'),
    ) as typeof wf;
    expect(namesTruthMarker(wf, wf)).toBe(false);
    expect(namesTruthMarker(wf, leaked)).toBe(true);
  });
});

describe('a case run with the oracle provider', () => {
  it('heals a selector change, writes the heal and a correct benchmark label, and meters the call', async () => {
    const { result, records, ledger } = await runWithOracle(
      byId('portal-rename-and-restyle-orders-link'),
    );
    expect(result.initial).toMatchObject({ status: 'failed', failedStep: 'click_002' });
    expect(result.outcome).toBe('healed');
    expect(result.judgement).toEqual({ verdict: 'correct', reasons: [] });
    expect(result.heals).toHaveLength(1);
    expect(result.heals[0]).toMatchObject({
      trigger: 'failure',
      patchClass: 'selector',
      decision: 'awaiting_approval',
      oracleClass: 'selector',
      oracleAgrees: true,
      triage: { route: 'heal' },
    });
    expect(records.map((r) => r.kind)).toEqual(['heal', 'label']);
    expect(labels(records)[0]).toMatchObject({
      healId: result.heals[0]!.healId,
      verdict: 'correct',
      source: 'benchmark',
    });
    expect(ledger.totals().calls).toBe(1);
    expect(result.usage.calls).toBe(1);
    expect(result.usage.unpricedCalls).toBe(0);
  });

  it('promotes a degraded step without a model call', async () => {
    const { result, ledger } = await runWithOracle(byId('portal-rename-orders-link'));
    expect(result.initial.degraded).toEqual(['click_002']);
    expect(result.outcome).toBe('healed');
    expect(result.heals[0]).toMatchObject({ trigger: 'degraded', patchClass: 'promotion' });
    expect(result.judgement?.verdict).toBe('correct');
    expect(ledger.totals().calls).toBe(0);
  });

  it('inserts a dismiss click for a banner', async () => {
    const { result } = await runWithOracle(byId('portal-cookie-banner'));
    expect(result.outcome).toBe('healed');
    expect(result.heals[0]).toMatchObject({ patchClass: 'insert_step' });
    expect(result.judgement?.verdict).toBe('correct');
  });

  it('labels a heal that picks the decoy as a false heal, though it verified', async () => {
    const trap = byId('portal-renamed-link-with-decoy');
    const wrong: DriftCase = {
      ...trap,
      oracle: [
        {
          kind: 'reselect',
          stepId: 'click_002',
          candidates: [{ kind: 'role', value: "link[name='Order archive']" }],
        },
      ],
    };
    const { result, records } = await runWithOracle(wrong);
    expect(result.outcome).toBe('healed');
    expect(result.judgement?.verdict).toBe('false_heal');
    expect(result.heals[0]?.decision).toBeDefined();
    expect(labels(records)[0]).toMatchObject({ verdict: 'false_heal', source: 'benchmark' });
  });

  it('records a removed element as not healed, with no label', async () => {
    const { result, records } = await runWithOracle(byId('portal-orders-link-removed'));
    expect(result.outcome).toBe('not_healed');
    expect(result.judgement).toBeUndefined();
    expect(labels(records)).toHaveLength(0);
  });

  it('records a change the workflow survives as never reaching the healer', async () => {
    const { result, records } = await runWithOracle(byId('portal-orders-link-uppercase'));
    expect(result.outcome).toBe('not_invoked');
    expect(result.heals).toHaveLength(0);
    expect(records).toHaveLength(0);
  });
});
