import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Locator, Page, VaultResolver } from '../src/index.js';
import {
  DEFAULT_SECRET_ENV_PREFIX,
  EnvVaultResolver,
  VaultSecretMissingError,
  VaultSecretNotAllowedError,
  createWorkflowContext,
} from '../src/index.js';

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

const originalEnv = { ...process.env };
let warnings: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnings = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...originalEnv };
  warnings.mockRestore();
});

describe('EnvVaultResolver (default vault inside WorkflowContext)', () => {
  it('uses SFYSH_SECRET_ as the default prefix', () => {
    expect(DEFAULT_SECRET_ENV_PREFIX).toBe('SFYSH_SECRET_');
  });

  it('resolves secrets from the prefixed, upper-cased variable', () => {
    process.env['SFYSH_SECRET_PORTAL_PASSWORD'] = 'hunter2';
    const ctx = createWorkflowContext({ page: stubPage });
    expect(ctx.vault('portal_password')).toBe('hunter2');
    expect(warnings).not.toHaveBeenCalled();
  });

  it('prefers the prefixed variable when both are set', () => {
    process.env['SFYSH_SECRET_BOTH_SET'] = 'prefixed';
    process.env['BOTH_SET'] = 'bare';
    expect(new EnvVaultResolver().resolve('both_set')).toBe('prefixed');
    expect(warnings).not.toHaveBeenCalled();
  });

  it('throws VaultSecretMissingError when neither variable is set', () => {
    delete process.env['NOT_CONFIGURED_SECRET'];
    const ctx = createWorkflowContext({ page: stubPage });
    expect(() => ctx.vault('not_configured_secret')).toThrow(VaultSecretMissingError);
  });

  it('throws when the variable is an empty string', () => {
    process.env['SFYSH_SECRET_EMPTY_SECRET'] = '';
    const ctx = createWorkflowContext({ page: stubPage });
    expect(() => ctx.vault('empty_secret')).toThrow(VaultSecretMissingError);
  });

  it('carries the secret name on the thrown error', () => {
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
    process.env['SFYSH_SECRET_DIRECT_SECRET'] = 'yes';
    const resolver = new EnvVaultResolver();
    expect(resolver.resolve('direct_secret')).toBe('yes');
    expect(resolver.resolve('nope')).toBeUndefined();
  });
});

describe('EnvVaultResolver: deprecated fallback to the unprefixed variable', () => {
  it('still reads the unprefixed variable and warns', () => {
    process.env['LEGACY_ONE'] = 'old-value';
    expect(new EnvVaultResolver().resolve('legacy_one')).toBe('old-value');
    expect(warnings).toHaveBeenCalledTimes(1);
    const [message, options] = warnings.mock.calls[0] as [string, { type: string; code: string }];
    expect(message).toContain('SFYSH_SECRET_LEGACY_ONE');
    expect(message).not.toContain('old-value');
    expect(options).toEqual({ type: 'DeprecationWarning', code: 'SFYSH_UNPREFIXED_SECRET' });
  });

  it('warns once per name, across resolvers', () => {
    process.env['LEGACY_TWO'] = 'old-value';
    new EnvVaultResolver().resolve('legacy_two');
    new EnvVaultResolver().resolve('legacy_two');
    createWorkflowContext({ page: stubPage }).vault('legacy_two');
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it('falls back when the prefixed variable is empty', () => {
    process.env['SFYSH_SECRET_LEGACY_THREE'] = '';
    process.env['LEGACY_THREE'] = 'old-value';
    expect(new EnvVaultResolver().resolve('legacy_three')).toBe('old-value');
  });

  it.each([
    ['the default prefix, set explicitly', { prefix: DEFAULT_SECRET_ENV_PREFIX }],
    ['a custom prefix', { prefix: 'ACME_' }],
  ])('is off with %s', (_name, options) => {
    process.env['LEGACY_FOUR'] = 'old-value';
    expect(new EnvVaultResolver(options).resolve('legacy_four')).toBeUndefined();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('stays on when only an allowlist is set', () => {
    process.env['LEGACY_FIVE'] = 'old-value';
    const resolver = new EnvVaultResolver({ allow: ['legacy_five'] });
    expect(resolver.resolve('legacy_five')).toBe('old-value');
    expect(warnings).toHaveBeenCalledTimes(1);
  });
});

describe('EnvVaultResolver: prefix', () => {
  it('reads from a custom prefix', () => {
    process.env['ACME_PORTAL_PASS'] = 'from-acme';
    process.env['SFYSH_SECRET_PORTAL_PASS'] = 'from-default';
    expect(new EnvVaultResolver({ prefix: 'ACME_' }).resolve('portal_pass')).toBe('from-acme');
  });

  it('cannot reach a variable outside the prefix', () => {
    process.env['AWS_SECRET_ACCESS_KEY'] = 'do-not-read';
    const resolver = new EnvVaultResolver({ prefix: DEFAULT_SECRET_ENV_PREFIX });
    expect(resolver.resolve('aws_secret_access_key')).toBeUndefined();
    const ctx = createWorkflowContext({ page: stubPage, vaultResolver: resolver });
    expect(() => ctx.vault('aws_secret_access_key')).toThrow(VaultSecretMissingError);
  });

  it('reads unprefixed variables without a warning when the prefix is empty', () => {
    process.env['BARE_ON_PURPOSE'] = 'bare';
    expect(new EnvVaultResolver({ prefix: '' }).resolve('bare_on_purpose')).toBe('bare');
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe('EnvVaultResolver: allowlist', () => {
  it('resolves a listed name', () => {
    process.env['SFYSH_SECRET_PORTAL_PASS'] = 'hunter2';
    const resolver = new EnvVaultResolver({ allow: ['portal_pass'] });
    expect(resolver.resolve('portal_pass')).toBe('hunter2');
  });

  it('throws VaultSecretNotAllowedError for any other name, set or not', () => {
    process.env['SFYSH_SECRET_OTHER_PASS'] = 'set-but-not-listed';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'do-not-read';
    const resolver = new EnvVaultResolver({ allow: ['portal_pass'] });
    for (const name of ['other_pass', 'aws_secret_access_key', 'PORTAL_PASS', '']) {
      expect(() => resolver.resolve(name)).toThrow(VaultSecretNotAllowedError);
    }
    expect(warnings).not.toHaveBeenCalled();
  });

  it('allows nothing when the list is empty', () => {
    process.env['SFYSH_SECRET_PORTAL_PASS'] = 'hunter2';
    const resolver = new EnvVaultResolver({ allow: [] });
    expect(() => resolver.resolve('portal_pass')).toThrow(VaultSecretNotAllowedError);
  });

  it('surfaces through ctx.vault as its own error, with the name and no value', () => {
    process.env['SFYSH_SECRET_OTHER_PASS'] = 'set-but-not-listed';
    const ctx = createWorkflowContext({
      page: stubPage,
      vaultResolver: new EnvVaultResolver({ allow: ['portal_pass'] }),
    });
    try {
      ctx.vault('other_pass');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultSecretNotAllowedError);
      expect(err).not.toBeInstanceOf(VaultSecretMissingError);
      expect((err as VaultSecretNotAllowedError).secretName).toBe('other_pass');
      expect((err as Error).message).not.toContain('set-but-not-listed');
    }
  });

  it('copies the list, so later changes to the array do not widen it', () => {
    const allow = ['portal_pass'];
    const resolver = new EnvVaultResolver({ allow });
    allow.push('other_pass');
    expect(() => resolver.resolve('other_pass')).toThrow(VaultSecretNotAllowedError);
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
