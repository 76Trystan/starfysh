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
import { ALL_CASES, PORTAL_CASES } from './cases.js';
import { judgeHeal, loadFixture, observe } from './drift.js';
import { applyOracle } from './oracle.js';
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

describe('the shop fixture', () => {
  it('runs clean, records the elements it acted on, and produces the garden products and delivery', async () => {
    const shop = loadFixture('shop');
    const baseline = await observe(browser, shop, []);
    expect(baseline.status).toBe('ok');
    expect(baseline.truth).toEqual([
      'click:click_002',
      'click:click_003',
      'fill:fill_005',
      'click:click_006',
    ]);
    expect(baseline.outputs).toEqual([
      { products: ['Rake', 'Hose', 'Trowel'] },
      { delivery: 'Delivery to 2000 in 2 days' },
    ]);
  });
});

describe('the suite', () => {
  it('has at least 50 cases, unique ids, and every effect and heal represented', () => {
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(ALL_CASES.map((c) => c.id)).size).toBe(ALL_CASES.length);
    const effects = new Set(ALL_CASES.map((c) => c.expect.effect));
    const heals = new Set(ALL_CASES.map((c) => c.expect.heal));
    expect([...effects].sort()).toEqual(['degrades', 'fails', 'none', 'silent']);
    expect([...heals].sort()).toEqual([
      'insert_step',
      'none',
      'not_healable',
      'promotion',
      'selector',
    ]);
    expect(ALL_CASES.filter((c) => c.expect.trap).length).toBeGreaterThanOrEqual(4);
  });

  it('has an oracle on every healable case, none on the rest, and gaps only where nothing can be healed', () => {
    for (const c of ALL_CASES) {
      const healable = ['promotion', 'selector', 'insert_step'].includes(c.expect.heal);
      expect({ id: c.id, oracle: c.oracle !== undefined }).toEqual({ id: c.id, oracle: healable });
      if (c.expect.gap !== undefined) expect(c.expect.heal).toBe('not_healable');
    }
  });
});

describe('each drift case does what it claims', () => {
  const baselines = new Map<string, Promise<Observation>>();
  const baselineOf = (name: string) => {
    if (!baselines.has(name)) baselines.set(name, observe(browser, loadFixture(name), []));
    return baselines.get(name)!;
  };

  it.concurrent.each(ALL_CASES.map((c) => [c.id, c] as const))('%s', async (_id, driftCase) => {
    const fx = loadFixture(driftCase.fixture);
    const run = await observe(browser, fx, driftCase.drifts);
    const firstOnly = await observe(browser, fx, driftCase.drifts, fx.workflow, {
      candidates: 'first',
    });
    const { effect, step } = driftCase.expect;

    if (effect === 'none') {
      expect(run.status).toBe('ok');
      expect(run.degraded).toBeUndefined();
      expect(firstOnly.status).toBe('ok');
      expect(run.outputs).toEqual((await baselineOf(driftCase.fixture)).outputs);
    } else if (effect === 'silent') {
      // Passes, with no fallback, but reads something else: the healer is never told.
      expect(run.status).toBe('ok');
      expect(run.degraded).toBeUndefined();
      expect(run.outputs).not.toEqual((await baselineOf(driftCase.fixture)).outputs);
    } else if (effect === 'degrades') {
      expect(run.status).toBe('ok');
      expect(run.degraded?.map((d) => d.stepId)).toEqual(driftCase.expect.steps ?? [step]);
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

describe("every healable case is solvable within the healer's rules", () => {
  const baselines = new Map<string, Promise<Observation>>();
  const baselineOf = (name: string) => {
    if (!baselines.has(name)) baselines.set(name, observe(browser, loadFixture(name), []));
    return baselines.get(name)!;
  };
  const healable = ALL_CASES.filter((c) => c.oracle !== undefined);

  it.concurrent.each(healable.map((c) => [c.id, c] as const))('%s', async (_id, driftCase) => {
    const fx = loadFixture(driftCase.fixture);
    // Throws if any oracle patch breaks the healer's own rules for its class.
    const { workflow, patches } = applyOracle(fx.workflow, driftCase.oracle!);
    expect(patches[0]!.patchClass).toBe(driftCase.expect.heal);

    // Verified the way the healer verifies: first candidates only.
    const run = await observe(browser, fx, driftCase.drifts, workflow, { candidates: 'first' });
    const judgement = judgeHeal(await baselineOf(driftCase.fixture), run);
    expect(judgement).toEqual({ verdict: 'correct', reasons: [] });
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
