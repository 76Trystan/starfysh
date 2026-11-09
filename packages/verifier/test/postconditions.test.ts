import { describe, it, expect } from 'vitest';
import type { Page, Locator } from '@sfysh/runtime';
import { evaluateCondition, evaluateConditions } from '../src/postconditions.js';

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
    url: () => 'https://example.com/path',
    locator: () => stubLocator(),
    getByRole: () => stubLocator(),
    getByTestId: () => stubLocator(),
    getByText: () => stubLocator(),
    getByLabel: () => stubLocator(),
    waitForTimeout: async () => {},
  };
  return { ...base, ...overrides };
}

describe('evaluateCondition', () => {
  it('holds when urlMatches regex matches', async () => {
    const page = stubPage({ url: () => 'https://example.com/orders/42' });
    const r = await evaluateCondition(page, { urlMatches: '/orders/\\d+' });
    expect(r.status).toBe('held');
  });

  it('holds when urlMatches is a plain substring', async () => {
    const page = stubPage({ url: () => 'https://example.com/orders/42' });
    const r = await evaluateCondition(page, { urlMatches: '/orders/' });
    expect(r.status).toBe('held');
  });

  it('is violated when urlMatches does not match', async () => {
    const page = stubPage({ url: () => 'https://example.com/other' });
    const r = await evaluateCondition(page, { urlMatches: '/orders/' });
    expect(r.status).toBe('violated');
    expect(r.reason).toContain('/orders/');
  });

  it('holds when urlEquals matches exactly', async () => {
    const page = stubPage({ url: () => 'https://example.com/a' });
    const r = await evaluateCondition(page, { urlEquals: 'https://example.com/a' });
    expect(r.status).toBe('held');
  });

  it('is violated when urlEquals differs', async () => {
    const page = stubPage({ url: () => 'https://example.com/a' });
    const r = await evaluateCondition(page, { urlEquals: 'https://example.com/b' });
    expect(r.status).toBe('violated');
  });

  it('holds when selectorVisible is visible', async () => {
    const page = stubPage({ locator: () => stubLocator({ isVisible: async () => true }) });
    const r = await evaluateCondition(page, { selectorVisible: '.ok' });
    expect(r.status).toBe('held');
  });

  it('is violated when selectorVisible is not visible', async () => {
    const page = stubPage({ locator: () => stubLocator({ isVisible: async () => false }) });
    const r = await evaluateCondition(page, { selectorVisible: '.ok' });
    expect(r.status).toBe('violated');
  });

  it('holds when selectorAbsent returns zero matches', async () => {
    const page = stubPage({ locator: () => stubLocator({ count: async () => 0 }) });
    const r = await evaluateCondition(page, { selectorAbsent: '.spinner' });
    expect(r.status).toBe('held');
  });

  it('is violated when selectorAbsent still has matches', async () => {
    const page = stubPage({ locator: () => stubLocator({ count: async () => 2 }) });
    const r = await evaluateCondition(page, { selectorAbsent: '.spinner' });
    expect(r.status).toBe('violated');
    expect(r.reason).toContain('2');
  });

  it('holds when textPresent is found', async () => {
    const page = stubPage({ getByText: () => stubLocator({ count: async () => 1 }) });
    const r = await evaluateCondition(page, { textPresent: 'Submitted' });
    expect(r.status).toBe('held');
  });

  it('is violated when textPresent is missing', async () => {
    const page = stubPage({ getByText: () => stubLocator({ count: async () => 0 }) });
    const r = await evaluateCondition(page, { textPresent: 'Submitted' });
    expect(r.status).toBe('violated');
  });

  it('marks responseStatus unsupported', async () => {
    const r = await evaluateCondition(stubPage(), { responseStatus: 200 });
    expect(r.status).toBe('unsupported');
  });

  it('evaluates a batch in order', async () => {
    const page = stubPage({ url: () => 'https://example.com/done' });
    const results = await evaluateConditions(page, [
      { urlMatches: '/done' },
      { urlMatches: '/nope' },
    ]);
    expect(results.map((r) => r.status)).toEqual(['held', 'violated']);
  });
});
