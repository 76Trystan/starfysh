import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  vault,
  setVaultResolver,
  EnvVaultResolver,
  VaultSecretMissingError,
  type VaultResolver,
} from '../src/index.js';

describe('EnvVaultResolver', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setVaultResolver(new EnvVaultResolver());
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves secrets by upper-cased name from process.env', () => {
    process.env['PORTAL_PASSWORD'] = 'hunter2';
    expect(vault('portal_password')).toBe('hunter2');
  });

  it('throws VaultSecretMissingError when the env var is not set', () => {
    delete process.env['NOT_CONFIGURED_SECRET'];
    expect(() => vault('not_configured_secret')).toThrow(VaultSecretMissingError);
  });

  it('throws when the env var is empty string', () => {
    process.env['EMPTY_SECRET'] = '';
    expect(() => vault('empty_secret')).toThrow(VaultSecretMissingError);
  });

  it('carries the secret name on the thrown error', () => {
    delete process.env['NAMED_MISSING'];
    try {
      vault('named_missing');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultSecretMissingError);
      expect((err as VaultSecretMissingError).secretName).toBe('named_missing');
    }
  });
});

describe('setVaultResolver', () => {
  afterEach(() => {
    setVaultResolver(new EnvVaultResolver());
  });

  it('replaces the active resolver', () => {
    const stub: VaultResolver = {
      resolve: (name) => (name === 'stubbed' ? 'from-stub' : undefined),
    };
    setVaultResolver(stub);
    expect(vault('stubbed')).toBe('from-stub');
  });

  it('subsequent calls use the new resolver', () => {
    setVaultResolver({ resolve: () => 'first' });
    expect(vault('any')).toBe('first');
    setVaultResolver({ resolve: () => 'second' });
    expect(vault('any')).toBe('second');
  });
});
