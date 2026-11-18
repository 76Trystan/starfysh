import { describe, expect, it } from 'vitest';
import { applyPatch, hashWorkflow } from '@sfysh/ir';
import type { StepPatch, Workflow } from '@sfysh/ir';
import type { DegradedStep, Locator, Page } from '@sfysh/runtime';
import {
  checkPatchClass,
  decidePatch,
  MemoryHealHistory,
  patchRecord,
  promote,
  promotionPatch,
  promotionRecord,
  PROMOTION_SCORE,
  renderReview,
} from '../src/index.js';
import type { PatchVerification } from '../src/index.js';

type Loose = Record<string, unknown>;

const workflow = {
  irVersion: '1.0.0',
  id: 'wf_orders',
  name: 'Read the latest order',
  steps: [
    {
      id: 'nav_001',
      intent: 'Open the portal.',
      action: 'navigate',
      url: 'https://portal.example.com/',
    },
    {
      id: 'click_002',
      intent: 'Open the orders page.',
      action: 'click',
      target: {
        candidates: [
          { kind: 'role', value: "link[name='Orders']" },
          { kind: 'css', value: 'nav a.orders' },
          { kind: 'role', value: "link[name='My orders']" },
        ],
      },
    },
    {
      id: 'extract_003',
      intent: 'Read the latest order number.',
      action: 'extract',
      target: { candidates: [{ kind: 'css', value: 'h1' }] },
      schema: { type: 'string' },
    },
  ],
} as unknown as Workflow;

/** A site where only the listed link names exist, and the heading reads `heading`. */
function sitePage(links: string[], heading = 'Order 1042'): Page {
  const locator = (exists: boolean, texts: string[] = []): Locator =>
    ({
      click: async () => {
        if (!exists) {
          const error = new Error('locator.click: Timeout 30000ms exceeded.');
          error.name = 'TimeoutError';
          throw error;
        }
      },
      fill: async () => {},
      isVisible: async () => exists,
      count: async () => (exists ? 1 : 0),
      allTextContents: async () => texts,
      all: async () => [],
      locator: () => locator(false),
      nth: () => locator(exists, texts),
    }) as unknown as Locator;
  return {
    goto: async () => {},
    url: () => 'https://portal.example.com/',
    waitForTimeout: async () => {},
    locator: (selector: string) => locator(selector === 'h1', [heading]),
    getByRole: (_role: string, options?: { name?: string }) =>
      locator(links.includes(options?.name ?? '')),
    getByTestId: () => locator(false),
    getByText: () => locator(false),
    getByLabel: () => locator(false),
  } as unknown as Page;
}

const renamed = () => sitePage(['My orders']);
const knownGood = { outputs: [{ extract_003: 'Order 1042' }] };
const degradedOn = (index: number, value: string, kind = 'role'): DegradedStep => ({
  stepId: 'click_002',
  candidateIndex: index,
  selector: { kind: kind as 'role', value },
});
const myOrders = degradedOn(2, "link[name='My orders']");

const firstCandidate = (wf: Workflow) =>
  ((wf.steps as unknown as Loose[])[1]!.target as { candidates: { value: string }[] })
    .candidates[0]!.value;

describe('promotionPatch', () => {
  it('moves the candidate that worked to the front and keeps the rest in order', () => {
    const built = promotionPatch(workflow, [myOrders]);
    expect(built.status).toBe('patch');
    if (built.status !== 'patch') return;
    const after = built.patch.after as unknown as Loose;
    expect((after.target as { candidates: unknown[] }).candidates).toEqual([
      { kind: 'role', value: "link[name='My orders']" },
      { kind: 'role', value: "link[name='Orders']" },
      { kind: 'css', value: 'nav a.orders' },
    ]);
    expect(built.patch).toMatchObject({
      op: 'replace',
      stepId: 'click_002',
      baseHash: hashWorkflow(workflow),
      confidence: PROMOTION_SCORE,
    });
    expect(built.patch.rationale).toContain('No model wrote this change');
    expect(built.score).toMatchObject({ score: PROMOTION_SCORE, level: 'high' });
    expect(built.score.signals.map((s) => s.code)).toEqual(['worked_live']);
  });

  it('skips a record whose candidate does not match the workflow', () => {
    const built = promotionPatch(workflow, [degradedOn(2, "link[name='Elsewhere']")]);
    expect(built).toMatchObject({
      status: 'none',
      skipped: [{ stepId: 'click_002', reason: 'candidate_mismatch' }],
    });
  });

  it('skips a step that degraded onto different candidates in one run', () => {
    const built = promotionPatch(workflow, [myOrders, degradedOn(1, 'nav a.orders', 'css')]);
    expect(built).toMatchObject({
      status: 'none',
      skipped: [{ reason: 'inconsistent' }],
    });
  });

  it('skips an unknown step and promotes the next, leaving later steps for another run', () => {
    const built = promotionPatch(workflow, [
      { stepId: 'gone_009', candidateIndex: 1, selector: { kind: 'css', value: 'x' } },
      myOrders,
      { stepId: 'other_010', candidateIndex: 1, selector: { kind: 'css', value: 'y' } },
    ]);
    expect(built.status).toBe('patch');
    if (built.status !== 'patch') return;
    expect(built.skipped).toEqual([expect.objectContaining({ reason: 'unknown_step' })]);
    expect(built.remaining.map((d) => d.stepId)).toEqual(['other_010']);
  });

  it('returns none for no degraded steps', () => {
    expect(promotionPatch(workflow, [])).toEqual({ status: 'none', skipped: [] });
  });
});

describe('the promotion allowlist', () => {
  const promoted = () => {
    const built = promotionPatch(workflow, [myOrders]);
    if (built.status !== 'patch') throw new Error('expected a patch');
    return built.patch;
  };
  const withCandidates = (candidates: unknown[]): StepPatch => {
    const patch = promoted();
    const after = patch.after as unknown as Loose;
    return {
      ...patch,
      after: { ...after, target: { candidates } } as unknown as StepPatch['after'],
    };
  };

  it('accepts a pure reorder', () => {
    expect(checkPatchClass(promoted(), workflow, 'promotion')).toEqual({ ok: true });
  });

  it.each([
    [
      'an added candidate',
      [
        { kind: 'role', value: "link[name='My orders']" },
        { kind: 'role', value: "link[name='Orders']" },
        { kind: 'css', value: 'nav a.orders' },
        { kind: 'css', value: '#new' },
      ],
    ],
    [
      'a dropped candidate',
      [
        { kind: 'role', value: "link[name='My orders']" },
        { kind: 'role', value: "link[name='Orders']" },
      ],
    ],
    [
      'an edited candidate',
      [
        { kind: 'role', value: "link[name='My orders']" },
        { kind: 'role', value: "link[name='Orders']" },
        { kind: 'css', value: 'nav a.other' },
      ],
    ],
  ])('refuses %s', (_label, candidates) => {
    const result = checkPatchClass(withCandidates(candidates), workflow, 'promotion');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.violations.map((v) => v.code)).toContain('not_a_reorder');
  });

  it('refuses any other field change, as a selector patch does', () => {
    const patch = promoted();
    const tampered = {
      ...patch,
      after: { ...(patch.after as unknown as Loose), intent: 'Something else.' },
    } as unknown as StepPatch;
    const result = checkPatchClass(tampered, workflow, 'promotion');
    expect(!result.ok && result.violations.map((v) => v.code)).toContain('field_not_allowed');
  });
});

describe('promote', () => {
  it('verifies the promotion live and holds it for a person by default', async () => {
    const history = new MemoryHealHistory();
    const result = await promote({
      workflow,
      degraded: [myOrders],
      knownGood,
      pageFactory: renamed,
      history,
    });
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision.status).toBe('awaiting_approval');
    expect(result.attempt.verification).toMatchObject({ status: 'verified', stepRan: 'confirmed' });
    expect(history.patches(workflow.id)).toHaveLength(1);
    // Promotions do not count against the daily heal cap.
    expect(history.count(workflow.id, new Date(0))).toBe(0);
    expect(renderReview(result.decision, { workflow })).toContain('reordered');
  });

  it('accepts a verified promotion without a person under auto_promotion', async () => {
    const result = await promote({
      workflow,
      degraded: [myOrders],
      knownGood,
      pageFactory: renamed,
      history: new MemoryHealHistory(),
      policy: { mode: 'auto_promotion' },
    });
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision).toMatchObject({ status: 'accepted', acceptedBy: { kind: 'policy' } });
    if (result.decision.status !== 'accepted') return;
    expect(firstCandidate(result.decision.workflow)).toBe("link[name='My orders']");
  });

  it('still holds a promotion that undoes an earlier heal, under auto_promotion', async () => {
    const history = new MemoryHealHistory();
    // An earlier heal moved `Orders` away from the front; the site has flipped back.
    const earlier = promotionPatch(workflow, [myOrders]);
    if (earlier.status !== 'patch') throw new Error('expected a patch');
    const applied = applyPatch(workflow, earlier.patch);
    if (!applied.ok) throw new Error('expected the patch to apply');
    history.recordPatch(patchRecord(workflow, earlier.patch, 'accepted', new Date())!);

    const result = await promote({
      workflow: applied.workflow,
      degraded: [degradedOn(1, "link[name='Orders']")],
      knownGood,
      pageFactory: () => sitePage(['Orders']),
      history,
      policy: { mode: 'auto_promotion' },
    });
    expect(result.status).toBe('decided');
    if (result.status !== 'decided') return;
    expect(result.decision.status).toBe('awaiting_approval');
    if (result.decision.status !== 'awaiting_approval') return;
    expect(result.decision.reasons.map((r) => r.code)).toEqual(['reverts_earlier_heal']);
  });

  it('does not promote when the promoted workflow misses the known-good outputs', async () => {
    const result = await promote({
      workflow,
      degraded: [myOrders],
      knownGood: { outputs: [{ extract_003: 'Order 9999' }] },
      pageFactory: renamed,
      history: new MemoryHealHistory(),
      policy: { mode: 'auto_promotion' },
    });
    expect(result.status).toBe('not_promoted');
    if (result.status !== 'not_promoted') return;
    expect(result.attempt.verification.status).toBe('failed');
  });

  it('returns none when nothing can be promoted, without running anything', async () => {
    let pages = 0;
    const result = await promote({
      workflow,
      degraded: [degradedOn(2, "link[name='Elsewhere']")],
      knownGood,
      pageFactory: () => {
        pages++;
        return renamed();
      },
      history: new MemoryHealHistory(),
    });
    expect(result.status).toBe('none');
    expect(pages).toBe(0);
  });
});

describe('auto_promotion accepts promotions only', () => {
  it('holds a verified model-written selector patch for a person', () => {
    const built = promotionPatch(workflow, [myOrders]);
    if (built.status !== 'patch') throw new Error('expected a patch');
    const applied = applyPatch(workflow, built.patch);
    if (!applied.ok) throw new Error('expected the patch to apply');
    const verification: PatchVerification = {
      status: 'verified',
      patch: built.patch,
      workflow: applied.workflow,
      hash: applied.hash,
      report: {} as never,
      stepRan: 'confirmed',
    };
    const asSelector = decidePatch({
      workflow,
      patchClass: 'selector',
      score: built.score,
      verification,
      policy: { mode: 'auto_promotion' },
    });
    expect(asSelector.status).toBe('awaiting_approval');
    const asPromotion = decidePatch({
      workflow,
      patchClass: 'promotion',
      score: built.score,
      verification,
      policy: { mode: 'auto_promotion' },
    });
    expect(asPromotion.status).toBe('accepted');
  });
});

describe('promotionRecord', () => {
  it('records a promotion as a heal with a degraded trigger, no triage and no tokens', async () => {
    const result = await promote({
      workflow,
      degraded: [myOrders],
      knownGood,
      pageFactory: renamed,
      history: new MemoryHealHistory(),
    });
    if (result.status === 'none') throw new Error('expected a promotion');
    const record = promotionRecord({
      workflow,
      knownGood,
      result,
      redact: (t) => t,
      id: 'heal-1',
      at: new Date('2026-11-18T12:00:00Z'),
    });
    expect(record).toMatchObject({
      kind: 'heal',
      id: 'heal-1',
      trigger: 'degraded',
      degraded: { stepId: 'click_002', candidateIndex: 2 },
      outcome: { status: 'decided', patchClass: 'promotion', decision: 'awaiting_approval' },
      usage: { inputTokens: 0, outputTokens: 0 },
      attempts: [
        {
          patchClass: 'promotion',
          status: 'patch',
          verification: { status: 'verified' },
          decision: { status: 'awaiting_approval' },
        },
      ],
    });
    expect(record.triage).toBeUndefined();
    expect(record.attempts[0]!.model).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('Order 1042');
  });
});
