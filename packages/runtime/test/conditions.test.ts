import { describe, it, expect } from 'vitest';
import {
  assertCondition,
  createWorkflowContext,
  evaluateCondition,
  PostconditionViolation,
} from '../src/index.js';
import type { Locator, Page } from '../src/index.js';

function stubLocator(overrides: Partial<Locator> = {}): Locator {
  const base: Locator = {
    click: async () => {},
    fill: async () => {},
    isVisible: async () => false,
    locator: () => stubLocator(overrides),
    count: async () => 0,
    nth: () => stubLocator(overrides),
    allTextContents: async () => [],
    all: async () => [],
  };
  return { ...base, ...overrides };
}

function stubPage(overrides: Partial<Page> = {}): Page {
  const base: Page = {
    goto: async () => {},
    url: () => 'https://example.com/page',
    locator: () => stubLocator(),
    getByRole: () => stubLocator(),
    getByTestId: () => stubLocator(),
    getByText: () => stubLocator(),
    getByLabel: () => stubLocator(),
    waitForTimeout: async () => {},
  };
  return { ...base, ...overrides };
}

describe('evaluateCondition (runtime)', () => {
  it('holds when urlMatches regex matches', async () => {
    const r = await evaluateCondition(stubPage({ url: () => 'https://example.com/orders/42' }), {
      urlMatches: '/orders/\\d+',
    });
    expect(r.status).toBe('held');
  });

  it('holds when urlMatches falls back to substring', async () => {
    const r = await evaluateCondition(stubPage({ url: () => 'https://example.com/orders/42' }), {
      urlMatches: '/orders/',
    });
    expect(r.status).toBe('held');
  });

  it('is violated when urlEquals differs', async () => {
    const r = await evaluateCondition(stubPage({ url: () => 'https://example.com/a' }), {
      urlEquals: 'https://example.com/b',
    });
    expect(r.status).toBe('violated');
    expect(r.reason).toContain('https://example.com/b');
  });

  it('holds when selectorVisible is visible', async () => {
    const r = await evaluateCondition(
      stubPage({ locator: () => stubLocator({ isVisible: async () => true }) }),
      { selectorVisible: '.ok' },
    );
    expect(r.status).toBe('held');
  });

  it('is violated when selectorAbsent still has matches', async () => {
    const r = await evaluateCondition(
      stubPage({ locator: () => stubLocator({ count: async () => 2 }) }),
      { selectorAbsent: '.spinner' },
    );
    expect(r.status).toBe('violated');
    expect(r.reason).toContain('2');
  });

  it('is violated when textPresent is missing', async () => {
    const r = await evaluateCondition(
      stubPage({ getByText: () => stubLocator({ count: async () => 0 }) }),
      { textPresent: 'Submitted' },
    );
    expect(r.status).toBe('violated');
  });

  it('marks responseStatus unsupported', async () => {
    const r = await evaluateCondition(stubPage(), { responseStatus: 200 });
    expect(r.status).toBe('unsupported');
  });
});

describe('PostconditionViolation', () => {
  it('carries stepId, phase, condition, and reason on the error', () => {
    const condition = { urlMatches: '/done' };
    const err = new PostconditionViolation({
      stepId: 'step_final',
      phase: 'post',
      condition,
      reason: "URL 'https://example.com/elsewhere' did not match '/done'",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PostconditionViolation');
    expect(err.stepId).toBe('step_final');
    expect(err.phase).toBe('post');
    expect(err.condition).toBe(condition);
    expect(err.reason).toContain('/done');
    expect(err.message).toContain('step_final');
    expect(err.message).toContain('post');
  });
});

describe('assertCondition', () => {
  const ctx = createWorkflowContext({ page: stubPage() });

  it('returns undefined when the condition holds', async () => {
    const liveCtx = createWorkflowContext({
      page: stubPage({ url: () => 'https://example.com/done' }),
    });
    await expect(
      assertCondition(liveCtx, 'step_final', 'post', { urlMatches: '/done' }),
    ).resolves.toBeUndefined();
  });

  it('throws PostconditionViolation with the failing phase and stepId', async () => {
    const liveCtx = createWorkflowContext({
      page: stubPage({ url: () => 'https://example.com/elsewhere' }),
    });
    const condition = { urlMatches: '/done' };
    try {
      await assertCondition(liveCtx, 'step_final', 'pre', condition);
      expect.fail('expected PostconditionViolation');
    } catch (err) {
      expect(err).toBeInstanceOf(PostconditionViolation);
      const v = err as PostconditionViolation;
      expect(v.stepId).toBe('step_final');
      expect(v.phase).toBe('pre');
      expect(v.condition).toBe(condition);
      expect(v.reason).toContain('/done');
    }
  });

  it('does not throw on an unsupported result (responseStatus is a known hole)', async () => {
    await expect(
      assertCondition(ctx, 'step_final', 'post', { responseStatus: 200 }),
    ).resolves.toBeUndefined();
  });
});
