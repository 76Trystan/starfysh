import { describe, it, expect } from 'vitest';
import {
  conditionHolds,
  createWorkflowContext,
  DEFAULT_MAX_ITERATIONS,
  forEachItem,
  LoopLimitError,
  step,
  StepFailure,
  StepTimeoutError,
  UnsupportedConditionError,
  whileHolds,
  withTimeout,
} from '../src/index.js';
import type { Locator, Page } from '../src/index.js';

function page(overrides: Partial<Page> = {}): Page {
  const locator = {} as Locator;
  return {
    goto: async () => {},
    url: () => 'https://x.test/list?page=(2',
    locator: () => ({ ...locator, isVisible: async () => true }) as Locator,
    getByRole: () => locator,
    getByTestId: () => locator,
    getByText: () => ({ ...locator, count: async () => 1 }) as Locator,
    getByLabel: () => locator,
    waitForTimeout: async () => {},
    ...overrides,
  };
}

describe('conditionHolds', () => {
  it('uses the same evaluator as pre and post checks, so urlMatches falls back to a substring', async () => {
    expect(await conditionHolds(page(), { urlMatches: '?page=(2' }, 's_1')).toBe(true);
    expect(await conditionHolds(page(), { urlMatches: '/list' }, 's_1')).toBe(true);
    expect(await conditionHolds(page(), { urlEquals: 'https://other/' }, 's_1')).toBe(false);
  });

  it('throws for a condition the page cannot answer, naming the step', async () => {
    const error = await conditionHolds(page(), { responseStatus: 200 }, 'g_1').catch((e) => e);
    expect(error).toBeInstanceOf(UnsupportedConditionError);
    expect((error as Error).message).toContain("step 'g_1'");
  });
});

describe('forEachItem', () => {
  const items = (n: number) => Array.from({ length: n }, () => ({}) as Locator);

  it('runs the body once per item, in order', async () => {
    const seen: Locator[] = [];
    const list = items(3);
    await forEachItem('lp', 10, list, async (item) => {
      seen.push(item);
    });
    expect(seen).toEqual(list);
  });

  it('fails on the iteration after the cap, having run the capped number', async () => {
    let runs = 0;
    const error = await forEachItem('lp', 2, items(5), async () => {
      runs++;
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LoopLimitError);
    expect((error as LoopLimitError).maxIterations).toBe(2);
    expect(runs).toBe(2);
  });

  it('allows exactly the cap', async () => {
    await expect(forEachItem('lp', 3, items(3), async () => {})).resolves.toBeUndefined();
  });
});

describe('whileHolds', () => {
  it('stops when the condition stops holding', async () => {
    let visible = 3;
    const p = page({
      locator: () => ({ isVisible: async () => visible > 0 }) as Locator,
    });
    let runs = 0;
    await whileHolds(p, 'lp', { selectorVisible: '.more' }, 10, async () => {
      runs++;
      visible--;
    });
    expect(runs).toBe(3);
  });

  it('fails a loop that never stops', async () => {
    let runs = 0;
    const error = await whileHolds(page(), 'lp', { selectorVisible: '.more' }, 4, async () => {
      runs++;
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LoopLimitError);
    expect(runs).toBe(4);
  });

  it('exports the schema default cap', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(100);
  });
});

describe('withTimeout and step() deadlines', () => {
  it('returns the body result when it finishes in time, or when there is no limit', async () => {
    expect(await withTimeout('s', 1000, async () => 'done')).toBe('done');
    expect(await withTimeout('s', undefined, async () => 'done')).toBe('done');
    expect(await withTimeout('s', 0, async () => 'done')).toBe('done');
  });

  it('fails a body that runs too long', async () => {
    const error = await withTimeout('s_1', 10, () => new Promise(() => {})).catch((e) => e);
    expect(error).toBeInstanceOf(StepTimeoutError);
    expect((error as StepTimeoutError).timeoutMs).toBe(10);
  });

  it('attributes a step timeout to the step', async () => {
    const ctx = createWorkflowContext({ page: page() });
    const error = await step(
      ctx,
      { id: 'nav_1', action: 'navigate' },
      () => new Promise<void>(() => {}),
      { timeoutMs: 10 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(StepFailure);
    expect((error as StepFailure).step.id).toBe('nav_1');
    expect((error as StepFailure).cause).toBeInstanceOf(StepTimeoutError);
  });

  it('leaves a step without options unlimited', async () => {
    const ctx = createWorkflowContext({ page: page() });
    expect(await step(ctx, { id: 's', action: 'click' }, async () => 7)).toBe(7);
  });
});
