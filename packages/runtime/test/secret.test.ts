import { describe, it, expect, afterEach } from 'vitest';
import type { Locator, Page, Secret } from '../src/index.js';
import { asSecret, createWorkflowContext } from '../src/index.js';

const stubPage: Page = {
  goto: async () => undefined,
  url: () => 'about:blank',
  locator: () => ({}) as unknown as Locator,
  getByRole: () => ({}) as unknown as Locator,
  getByTestId: () => ({}) as unknown as Locator,
  getByText: () => ({}) as unknown as Locator,
  getByLabel: () => ({}) as unknown as Locator,
  waitForTimeout: async () => undefined,
};

describe('Secret brand', () => {
  it('is structurally a string at runtime', () => {
    const s: Secret = asSecret('hunter2');
    expect(typeof s).toBe('string');
    expect(s.length).toBe(7);
    expect(s.slice(0, 4)).toBe('hunt');
  });

  it('ctx.vault returns a value that satisfies Secret', () => {
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'resolved' },
    });
    const value: Secret = ctx.vault('any');
    expect(value).toBe('resolved');
  });
});

describe('ctx.redact', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is identity when no secrets have been resolved', () => {
    const ctx = createWorkflowContext({ page: stubPage });
    expect(ctx.redact('arbitrary string with no secrets')).toBe('arbitrary string with no secrets');
  });

  it('is identity for empty input', () => {
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'resolved' },
    });
    ctx.vault('some_name');
    expect(ctx.redact('')).toBe('');
  });

  it('replaces a registered secret value with [REDACTED:<name>]', () => {
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'hunter2' },
    });
    ctx.vault('portal_pass');
    expect(ctx.redact('login failed with password hunter2')).toBe(
      'login failed with password [REDACTED:portal_pass]',
    );
  });

  it('replaces every occurrence of the same secret in the input', () => {
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'duplicated' },
    });
    ctx.vault('repeating');
    expect(ctx.redact('duplicated then duplicated then duplicated')).toBe(
      '[REDACTED:repeating] then [REDACTED:repeating] then [REDACTED:repeating]',
    );
  });

  it('scrubs multiple distinct secrets independently', () => {
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: {
        resolve: (name) => (name === 'user' ? 'alice' : 'wonderland'),
      },
    });
    ctx.vault('user');
    ctx.vault('pass');
    expect(ctx.redact('alice signed in with wonderland')).toBe(
      '[REDACTED:user] signed in with [REDACTED:pass]',
    );
  });

  it('sorts secrets longest-first so substring secrets do not fragment the longer match', () => {
    // Register the short secret first, then the long one that contains it.
    const resolver = { resolve: (name: string) => (name === 'short' ? 'abc' : 'abcdef') };
    const ctx = createWorkflowContext({ page: stubPage, vaultResolver: resolver });
    ctx.vault('short');
    ctx.vault('long');
    // 'abcdef' should be replaced as a whole, not as 'abc' + 'def'.
    expect(ctx.redact('abcdef')).toBe('[REDACTED:long]');
  });

  it('skips empty secret values without crashing', () => {
    // Vault throws on empty secret values, so simulate by registering a
    // resolver that returns a trimmed-to-empty value and expect vault to
    // throw. The redact path should remain identity before the throw.
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => '' },
    });
    expect(() => ctx.vault('empty')).toThrow();
    expect(ctx.redact('anything')).toBe('anything');
  });

  it('keeps per-context scrub state isolated between concurrent contexts', () => {
    const ctxA = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'secret-a' },
    });
    const ctxB = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'secret-b' },
    });
    ctxA.vault('a');
    ctxB.vault('b');
    expect(ctxA.redact('see secret-a and secret-b here')).toBe(
      'see [REDACTED:a] and secret-b here',
    );
    expect(ctxB.redact('see secret-a and secret-b here')).toBe(
      'see secret-a and [REDACTED:b] here',
    );
  });
});
