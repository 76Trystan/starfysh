// Self-tests for the drift module, against a real Chromium. They prove
// each case does what it claims to the fixture's workflow, and that the
// judge tells a right heal from a wrong one, before any measurement leans
// on either. Run with `pnpm --filter @sfysh/benchmark test:drift`; they
// need the Playwright browser (see benchmark/README.md), so they are not
// part of the repository's baseline `pnpm test`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import type { Workflow } from '@sfysh/ir';
import { patchClassOrder } from '@sfysh/healer';
import { PORTAL_CASES } from './cases.js';
import { judgeHeal, loadFixture, observe } from './drift.js';
import type { Observation } from './drift.js';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

const fixture = loadFixture('portal');

/** The fixture workflow with step `id` changed by `edit`. */
function withStep(id: string, edit: (step: Record<string, unknown>) => void): Workflow {
  const wf = structuredClone(fixture.workflow);
  const step = (wf.steps as unknown as Record<string, unknown>[]).find((s) => s.id === id)!;
  edit(step);
  return wf;
}

/** The fixture workflow with `step` inserted before step `id`. */
function withInsert(id: string, step: Record<string, unknown>): Workflow {
  const wf = structuredClone(fixture.workflow);
  const steps = wf.steps as unknown as Record<string, unknown>[];
  steps.splice(
    steps.findIndex((s) => s.id === id),
    0,
    step,
  );
  wf.steps = steps as unknown as Workflow['steps'];
  return wf;
}

describe('the portal fixture', () => {
  let baseline: Observation;
  beforeAll(async () => {
    baseline = await observe(browser, fixture, []);
  });

  it('runs clean, records the elements it acted on, and produces the ACME orders', () => {
    expect(baseline.status).toBe('ok');
    expect(baseline.truth).toEqual(['click:click_002', 'fill:fill_003', 'click:click_004']);
    expect(baseline.outputs).toEqual([
      {
        orders: [
          { order: 'A-1001', customer: 'ACME Corp', total: 120.5 },
          { order: 'A-1003', customer: 'ACME Ltd', total: 310 },
        ],
      },
      { heading: 'Orders (2)' },
    ]);
    expect(baseline.degraded).toBeUndefined();
  });

  it('judges the original workflow on the clean page as correct', () => {
    expect(judgeHeal(baseline, baseline)).toEqual({ verdict: 'correct', reasons: [] });
  });
});

describe('each drift case does what it claims', () => {
  it.each(PORTAL_CASES.map((c) => [c.id, c] as const))('%s', async (_id, driftCase) => {
    const run = await observe(browser, fixture, driftCase.drifts);
    const firstOnly = await observe(browser, fixture, driftCase.drifts, fixture.workflow, {
      candidates: 'first',
    });
    const { effect, step } = driftCase.expect;

    if (effect === 'none') {
      expect(run.status).toBe('ok');
      expect(run.degraded).toBeUndefined();
      expect(firstOnly.status).toBe('ok');
    } else if (effect === 'degrades') {
      expect(run.status).toBe('ok');
      expect(run.degraded?.map((d) => d.stepId)).toEqual([step]);
      expect(firstOnly.status).toBe('failed');
      expect(firstOnly.error?.stepId).toBe(step);
    } else {
      expect(run.status).toBe('failed');
      expect(run.error?.stepId).toBe(step);
      // A failure the healer is meant to fix must leave it a snapshot to work from.
      expect(run.outcome.snapshot?.text.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('is reproducible: the same drift gives the same page twice', async () => {
    const driftCase = PORTAL_CASES.find((c) => c.id === 'portal-renamed-link-with-decoy')!;
    const a = await observe(browser, fixture, driftCase.drifts);
    const b = await observe(browser, fixture, driftCase.drifts);
    expect(a.outcome.snapshot?.text).toBe(b.outcome.snapshot?.text);
    expect(a.error?.message).toBe(b.error?.message);
  });

  it('makes a covered element fail in the way the healer reads as needing an inserted step', async () => {
    const banner = PORTAL_CASES.find((c) => c.id === 'portal-cookie-banner')!;
    const run = await observe(browser, fixture, banner.drifts);
    expect(patchClassOrder({ message: run.error!.message })[0]).toBe('insert_step');
  });

  it('refuses a case whose drift selector matches nothing', async () => {
    await expect(
      observe(browser, fixture, [{ op: 'rename_text', selector: '#no-such-thing', text: 'x' }]),
    ).rejects.toThrow(/drift selector matches nothing/);
  });
});

describe('judgeHeal tells a right heal from a wrong one', () => {
  let baseline: Observation;
  beforeAll(async () => {
    baseline = await observe(browser, fixture, []);
  });
  const caseOf = (id: string) => PORTAL_CASES.find((c) => c.id === id)!;

  it('a promotion of the working fallback is correct', async () => {
    const promoted = withStep('click_002', (s) => {
      (s.target as { candidates: unknown[] }).candidates.reverse();
    });
    const run = await observe(
      browser,
      fixture,
      caseOf('portal-rename-orders-link').drifts,
      promoted,
      { candidates: 'first' },
    );
    expect(judgeHeal(baseline, run)).toEqual({ verdict: 'correct', reasons: [] });
  });

  it('new selectors for the real element are correct', async () => {
    const healed = withStep('click_002', (s) => {
      s.target = { candidates: [{ kind: 'role', value: "link[name='Purchases']" }] };
    });
    const run = await observe(
      browser,
      fixture,
      caseOf('portal-renamed-link-with-decoy').drifts,
      healed,
      { candidates: 'first' },
    );
    expect(judgeHeal(baseline, run).verdict).toBe('correct');
  });

  it('picking the decoy is a false heal, though it passes with identical outputs', async () => {
    const wrong = withStep('click_002', (s) => {
      s.target = { candidates: [{ kind: 'role', value: "link[name='Order archive']" }] };
    });
    const run = await observe(
      browser,
      fixture,
      caseOf('portal-renamed-link-with-decoy').drifts,
      wrong,
      { candidates: 'first' },
    );
    // Everything verification can see says this heal worked...
    expect(run.status).toBe('ok');
    expect(run.outputs).toEqual(baseline.outputs);
    // ...and it is still wrong.
    const judgement = judgeHeal(baseline, run);
    expect(judgement.verdict).toBe('false_heal');
    expect(judgement.reasons.join(' ')).toContain('click:decoy');
  });

  it('an inserted click on the banner button is correct', async () => {
    const healed = withInsert('click_002', {
      id: 'healed_001',
      intent: 'Accept the cookie banner.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Accept all']" }] },
    });
    const run = await observe(browser, fixture, caseOf('portal-cookie-banner').drifts, healed, {
      candidates: 'first',
    });
    expect(judgeHeal(baseline, run)).toEqual({ verdict: 'correct', reasons: [] });
  });

  it('a heal that fails or reads different outputs is not correct', async () => {
    const run = await observe(browser, fixture, caseOf('portal-rename-total-header').drifts);
    const judgement = judgeHeal(baseline, run);
    expect(judgement.verdict).toBe('false_heal');
    expect(judgement.reasons).toContain('the patched workflow failed on the drifted page');
  });
});
