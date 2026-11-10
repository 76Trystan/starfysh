import { describe, it, expect, afterEach } from 'vitest';
import type { Locator, Page, VaultResolver } from '../src/index.js';
import { EnvVaultResolver, VaultSecretMissingError, createWorkflowContext } from '../src/index.js';

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

describe('EnvVaultResolver (default vault inside WorkflowContext)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves secrets by upper-cased name from process.env', () => {
    process.env['PORTAL_PASSWORD'] = 'hunter2';
    const ctx = createWorkflowContext({ page: stubPage });
    expect(ctx.vault('portal_password')).toBe('hunter2');
  });

  it('throws VaultSecretMissingError when the env var is not set', () => {
    delete process.env['NOT_CONFIGURED_SECRET'];
    const ctx = createWorkflowContext({ page: stubPage });
    expect(() => ctx.vault('not_configured_secret')).toThrow(VaultSecretMissingError);
  });

  it('throws when the env var is empty string', () => {
    process.env['EMPTY_SECRET'] = '';
    const ctx = createWorkflowContext({ page: stubPage });
    expect(() => ctx.vault('empty_secret')).toThrow(VaultSecretMissingError);
  });

  it('carries the secret name on the thrown error', () => {
    delete process.env['NAMED_MISSING'];
    const ctx = createWorkflowContext({ page: stubPage });
    try {
      ctx.vault('named_missing');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultSecretMissingError);
      expect((err as VaultSecretMissingError).secretName).toBe('named_missing');
    }
  });

  it('EnvVaultResolver.resolve is callable directly', () => {
    process.env['DIRECT_SECRET'] = 'yes';
    const resolver = new EnvVaultResolver();
    expect(resolver.resolve('direct_secret')).toBe('yes');
    expect(resolver.resolve('nope')).toBeUndefined();
  });
});

describe('createWorkflowContext vaultResolver override', () => {
  it('uses a supplied resolver for ctx.vault', () => {
    const stub: VaultResolver = {
      resolve: (name) => (name === 'stubbed' ? 'from-stub' : undefined),
    };
    const ctx = createWorkflowContext({ page: stubPage, vaultResolver: stub });
    expect(ctx.vault('stubbed')).toBe('from-stub');
  });

  it('two contexts in the same process can use different resolvers', () => {
    const ctxA = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'from-a' },
    });
    const ctxB = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => 'from-b' },
    });
    expect(ctxA.vault('anything')).toBe('from-a');
    expect(ctxB.vault('anything')).toBe('from-b');
  });

  it('throws VaultSecretMissingError when the supplied resolver returns undefined', () => {
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: { resolve: () => undefined },
    });
    expect(() => ctx.vault('x')).toThrow(VaultSecretMissingError);
  });
});
