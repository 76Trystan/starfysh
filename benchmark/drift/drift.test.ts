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
import { CASE_SETS } from './case-sets.js';
import { ALL_CASES, PORTAL_CASES } from './cases.js';
import { judgeHeal, loadFixture, observe } from './drift.js';
import { applyOracle } from './oracle.js';
import type { Observation } from './drift.js';

// Every case in every case set, so a held-out set is held to the same
// checks as v1 from the moment it is added to `CASE_SETS`.
const EVERY_CASE = CASE_SETS.flatMap((set) => set.cases);

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

describe('the bank fixture', () => {
  it('runs clean, records the elements it acted on, and produces the October statement', async () => {
    const bank = loadFixture('bank');
    const baseline = await observe(browser, bank, []);
    expect(baseline.status).toBe('ok');
    expect(baseline.degraded).toBeUndefined();
    expect(baseline.truth).toEqual([
      'click:click_002',
      'click:click_003',
      'fill:fill_004',
      'fill:fill_005',
      'click:click_006',
    ]);
    expect(baseline.outputs).toEqual([
      {
        transactions: [
          { date: '2026-10-02', description: 'Salary', amount: 3200 },
          { date: '2026-10-05', description: 'Grocer', amount: -84.2 },
          { date: '2026-10-14', description: 'Electricity', amount: -132.75 },
          { date: '2026-10-30', description: 'Transfer to savings', amount: -500 },
        ],
      },
      { closingBalance: 'Closing balance $3,483.05' },
    ]);
  });

  it('reads a different statement when the look-alike account is chosen', async () => {
    const bank = loadFixture('bank');
    const wrongAccount = structuredClone(bank.workflow);
    const step = (wrongAccount.steps as unknown as Record<string, unknown>[]).find(
      (s) => s.id === 'click_003',
    )!;
    step.target = { candidates: [{ kind: 'role', value: "button[name='Savings account']" }] };
    const run = await observe(browser, bank, [], wrongAccount);
    expect(run.status).toBe('ok');
    expect(run.truth).toContain('click:none');
    expect(run.outputs).toEqual([
      {
        transactions: [
          { date: '2026-10-30', description: 'Transfer from everyday', amount: 500 },
          { date: '2026-10-31', description: 'Interest', amount: 12.4 },
        ],
      },
      { closingBalance: 'Closing balance $5,512.40' },
    ]);
  });
});

describe('the suppliers fixture', () => {
  const NORTHWIND_PACKAGING = {
    orderLines: [
      {
        po: 'PO-4452',
        item: 'Packing tape',
        quantity: 120,
        lineTotal: 186,
        ordered: '2026-09-04',
      },
      { po: 'PO-4481', item: 'Pallet wrap', quantity: 60, lineTotal: 412.8, ordered: '2026-10-02' },
      {
        po: 'PO-4503',
        item: 'Corrugated boxes',
        quantity: 250,
        lineTotal: 775,
        ordered: '2026-10-21',
      },
    ],
  };

  it("runs clean, records the elements it acted on, and reads Northwind Packaging's lines", async () => {
    const suppliers = loadFixture('suppliers');
    const baseline = await observe(browser, suppliers, []);
    expect(baseline.status).toBe('ok');
    expect(baseline.degraded).toBeUndefined();
    expect(baseline.truth).toEqual([
      'click:click_002',
      'click:click_003',
      'fill:fill_004',
      'fill:fill_005',
      'click:click_006',
    ]);
    expect(baseline.outputs).toEqual([
      NORTHWIND_PACKAGING,
      { orderTotal: 'Total for 3 lines: $1,373.80' },
    ]);
  });

  // Each look-alike is a working element beside the real one. Acting on it
  // must change the outputs, so a heal that picks it is caught by output
  // comparison as well as by the truth markers.
  it.each([
    [
      'the other Northwind supplier',
      'click_003',
      { kind: 'role', value: "link[name='Northwind Paper Co']" },
      'Total for 2 lines: $498.50',
    ],
    [
      'Delivered since instead of Ordered since',
      'fill_004',
      { kind: 'label', value: 'Delivered since' },
      'Total for 3 lines: $1,838.80',
    ],
    [
      'Minimum quantity instead of Minimum line total',
      'fill_005',
      { kind: 'label', value: 'Minimum quantity' },
      'Total for 2 lines: $961.00',
    ],
    [
      'Clear filters instead of Apply filters',
      'click_006',
      { kind: 'role', value: "button[name='Clear filters']" },
      '',
    ],
  ])('reads different outputs when %s is used', async (_, stepId, candidate, orderTotal) => {
    const suppliers = loadFixture('suppliers');
    const wrong = structuredClone(suppliers.workflow);
    const step = (wrong.steps as unknown as Record<string, unknown>[]).find(
      (s) => s.id === stepId,
    )!;
    step.target = { candidates: [candidate] };
    const run = await observe(browser, suppliers, [], wrong);
    expect(run.status).toBe('ok');
    expect(run.truth).toContain(`${stepId.startsWith('fill') ? 'fill' : 'click'}:none`);
    expect(run.outputs[1]).toEqual({ orderTotal });
    expect(run.outputs[0]).not.toEqual(NORTHWIND_PACKAGING);
  });

  it('survives reordered columns, since its script and the extract read by header', async () => {
    const suppliers = loadFixture('suppliers');
    const run = await observe(browser, suppliers, [
      { op: 'reorder_columns', table: 'table.order-lines', order: [3, 0, 5, 1, 4, 2] },
    ]);
    expect(run.status).toBe('ok');
    expect(run.outputs).toEqual([
      NORTHWIND_PACKAGING,
      { orderTotal: 'Total for 3 lines: $1,373.80' },
    ]);
  });
});

describe('every case set', () => {
  it('has unique case ids across all sets', () => {
    expect(new Set(EVERY_CASE.map((c) => c.id)).size).toBe(EVERY_CASE.length);
  });

  it('has an oracle on every healable case, none on the rest, and gaps only where nothing can be healed', () => {
    for (const c of EVERY_CASE) {
      const healable = ['promotion', 'selector', 'insert_step'].includes(c.expect.heal);
      expect({ id: c.id, oracle: c.oracle !== undefined }).toEqual({ id: c.id, oracle: healable });
      if (c.expect.gap !== undefined) expect(c.expect.heal).toBe('not_healable');
    }
  });
});

describe('the v1 suite', () => {
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
});

describe('the h1 held-out set', () => {
  const h1 = CASE_SETS.find((s) => s.name === 'h1')!;

  it('is held out, on the bank fixture only, with 20+ healable cases and decoys', () => {
    expect(h1.role).toBe('held_out');
    expect(new Set(h1.cases.map((c) => c.fixture))).toEqual(new Set(['bank']));
    expect(h1.cases.filter((c) => c.oracle !== undefined).length).toBeGreaterThanOrEqual(20);
    expect(h1.cases.filter((c) => c.expect.trap).length).toBeGreaterThanOrEqual(4);
    const heals = new Set(h1.cases.map((c) => c.expect.heal));
    expect([...heals].sort()).toEqual([
      'insert_step',
      'none',
      'not_healable',
      'promotion',
      'selector',
    ]);
  });
});

describe('the h2 held-out set', () => {
  const h2 = CASE_SETS.find((s) => s.name === 'h2')!;
  const count = (test: (c: (typeof h2.cases)[number]) => boolean) => h2.cases.filter(test).length;

  // The mix was fixed on 2026-11-24, before any h2 case was written, as
  // h1's proportions scaled by about 1.25 (see the header of cases-h2.ts).
  // It is checked here so the set cannot drift towards the cases a model
  // happens to do well or badly on.
  it('is held out, on the suppliers fixture only, with the mix fixed in advance', () => {
    expect(h2.role).toBe('held_out');
    expect(new Set(h2.cases.map((c) => c.fixture))).toEqual(new Set(['suppliers']));
    expect(h2.cases.length).toBeGreaterThanOrEqual(52);
    expect(count((c) => c.oracle !== undefined)).toBeGreaterThanOrEqual(34);
    expect(count((c) => c.expect.heal === 'selector')).toBe(16);
    expect(count((c) => c.expect.heal === 'promotion')).toBe(10);
    expect(count((c) => c.expect.heal === 'insert_step')).toBe(8);
    expect(count((c) => c.expect.trap === true)).toBeGreaterThanOrEqual(5);
    expect(count((c) => c.expect.heal === 'not_healable')).toBe(10);
    // Robustness and silent by what the healer sees: every case it should
    // never be called on, including complex ones (shadow DOM).
    expect(count((c) => c.expect.heal === 'none')).toBe(8);
    expect(new Set(h2.cases.flatMap((c) => (c.expect.gap ? [c.expect.gap] : [])))).toEqual(
      new Set(['ab_test', 'header_alias', 'iframe', 'intermittent']),
    );
  });
});

describe('each drift case does what it claims', () => {
  const baselines = new Map<string, Promise<Observation>>();
  const baselineOf = (name: string) => {
    if (!baselines.has(name)) baselines.set(name, observe(browser, loadFixture(name), []));
    return baselines.get(name)!;
  };

  it.concurrent.each(EVERY_CASE.map((c) => [c.id, c] as const))('%s', async (_id, driftCase) => {
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
  const healable = EVERY_CASE.filter((c) => c.oracle !== undefined);

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
