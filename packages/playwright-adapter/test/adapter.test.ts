import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workflow, resetWorkflows } from '@sfysh/runtime';
import { wrapWorkflowForTest, asPage, asLocator } from '../src/index.js';
import type { PlaywrightTestFn } from '../src/index.js';
import type { Page as PlaywrightPage, Locator as PlaywrightLocator } from 'playwright-core';

const stubPage = {} as PlaywrightPage;
const stubLocator = {} as PlaywrightLocator;

describe('asPage / asLocator', () => {
  it('asLocator returns the same object at runtime', () => {
    expect(asLocator(stubLocator)).toBe(stubLocator);
  });

  it('asPage forwards methods and properties to the real page with the right this', async () => {
    class FakePlaywrightPage {
      #secret = 'internal';
      readonly label = 'a property';
      url(): string {
        return `https://example.com/${this.#secret}`;
      }
      async goto(target: string): Promise<string> {
        return `went to ${target} with ${this.#secret}`;
      }
    }
    const real = new FakePlaywrightPage();
    const page = asPage(real as unknown as PlaywrightPage);

    // Private fields throw if `this` is the proxy, so these prove binding.
    expect(page.url()).toBe('https://example.com/internal');
    await expect(page.goto('https://x.test')).resolves.toBe('went to https://x.test with internal');
    expect((page as unknown as { label: string }).label).toBe('a property');
    expect(page instanceof FakePlaywrightPage).toBe(true);
  });

  it('asPage adds snapshot(), backed by the ARIA snapshot of the body', async () => {
    const selectors: string[] = [];
    const real = {
      locator: (selector: string) => {
        selectors.push(selector);
        return { ariaSnapshot: async () => '- heading "Dashboard" [level=1]' };
      },
    };
    const page = asPage(real as unknown as PlaywrightPage);

    expect(typeof page.snapshot).toBe('function');
    expect('snapshot' in page).toBe(true);
    await expect(page.snapshot!()).resolves.toBe('- heading "Dashboard" [level=1]');
    expect(selectors).toEqual(['body']);
  });

  it('asPage returns the same proxy for the same page', () => {
    const real = { locator: () => ({}) } as unknown as PlaywrightPage;
    expect(asPage(real)).toBe(asPage(real));
  });

  it('asPage leaves a page that already implements snapshot() untouched', () => {
    const custom = { snapshot: async () => 'custom' } as unknown as PlaywrightPage;
    expect(asPage(custom)).toBe(custom);
  });
});

describe('wrapWorkflowForTest', () => {
  beforeEach(() => {
    resetWorkflows();
  });

  it('registers a test using the workflow id as the title by default', () => {
    const mockTest = vi.fn() as unknown as PlaywrightTestFn;
    workflow('wrap-default-title', async () => {});

    wrapWorkflowForTest(mockTest, 'wrap-default-title');

    expect(mockTest).toHaveBeenCalledOnce();
    expect(vi.mocked(mockTest).mock.calls[0]?.[0]).toBe('wrap-default-title');
  });

  it('uses the custom title when provided', () => {
    const mockTest = vi.fn() as unknown as PlaywrightTestFn;
    workflow('wrap-custom-title', async () => {});

    wrapWorkflowForTest(mockTest, 'wrap-custom-title', { title: 'My readable title' });

    expect(vi.mocked(mockTest).mock.calls[0]?.[0]).toBe('My readable title');
  });

  it('resolves without throwing when the workflow succeeds', async () => {
    const calls: Array<{ title: string; fn: (f: { page: PlaywrightPage }) => Promise<void> }> = [];
    const mockTest: PlaywrightTestFn = (title, fn) => calls.push({ title, fn });

    workflow('wrap-ok', async () => {});
    wrapWorkflowForTest(mockTest, 'wrap-ok');

    await expect(calls[0]!.fn({ page: stubPage })).resolves.toBeUndefined();
  });

  it('throws when the workflow fails', async () => {
    const calls: Array<{ title: string; fn: (f: { page: PlaywrightPage }) => Promise<void> }> = [];
    const mockTest: PlaywrightTestFn = (title, fn) => calls.push({ title, fn });

    workflow('wrap-fail', async () => {
      throw new Error('step broke');
    });
    wrapWorkflowForTest(mockTest, 'wrap-fail');

    await expect(calls[0]!.fn({ page: stubPage })).rejects.toThrow('step broke');
  });

  it('throws a redacted error, never the raw cause', async () => {
    const calls: Array<{ title: string; fn: (f: { page: PlaywrightPage }) => Promise<void> }> = [];
    const mockTest: PlaywrightTestFn = (title, fn) => calls.push({ title, fn });

    class TimeoutError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TimeoutError';
      }
    }
    const raw = new TimeoutError(
      'locator.fill: Timeout 30000ms exceeded.\n  - fill("hunter2-secret")',
    );

    workflow('wrap-secret', async (ctx) => {
      ctx.vault('portal_pass');
      throw raw;
    });
    wrapWorkflowForTest(mockTest, 'wrap-secret', {
      vaultResolver: { resolve: () => 'hunter2-secret' },
    });

    const thrown = await calls[0]!.fn({ page: stubPage }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(raw);
    expect(thrown?.name).toBe('TimeoutError');
    expect(thrown?.message).toContain('fill("[REDACTED:portal_pass]")');
    expect(thrown?.message).not.toContain('hunter2-secret');
    expect(thrown?.stack).not.toContain('hunter2-secret');
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
  });
});
