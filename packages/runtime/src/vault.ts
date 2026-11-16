// Secret resolution types.
//
// The `vault(name)` helper that generated code calls is bound to the
// per-run WorkflowContext. This module exposes the pluggable VaultResolver
// interface, the default EnvVaultResolver, and the errors thrown when a
// secret is unavailable or off limits.

export interface VaultResolver {
  resolve(name: string): string | undefined;
}

/** Prefix the default resolver puts in front of the upper-cased secret name. */
export const DEFAULT_SECRET_ENV_PREFIX = 'SFYSH_SECRET_';

export interface EnvVaultResolverOptions {
  /**
   * Prefix for the environment variable. `supplier_password` with the
   * default prefix reads `SFYSH_SECRET_SUPPLIER_PASSWORD`. Setting this,
   * even to the default value, turns off the fallback to the unprefixed
   * variable. Pass `''` to read unprefixed variables on purpose.
   */
  prefix?: string;
  /**
   * The only secret names this resolver will resolve, compared exactly.
   * Any other name throws `VaultSecretNotAllowedError`. Typically the
   * `secrets` list of the workflow being run.
   */
  allow?: readonly string[];
}

/** Names already warned about, so a scheduled workflow warns once per process and not once per run. */
const warnedUnprefixed = new Set<string>();

/**
 * The default resolver. Reads a secret from the environment variable named
 * by the prefix plus the upper-cased secret name:
 * `supplier_password` -> `process.env.SFYSH_SECRET_SUPPLIER_PASSWORD`.
 *
 * The prefix is what stops a workflow definition from naming an unrelated
 * variable such as `aws_secret_access_key` and typing it into a page. A
 * workflow can only reach variables an operator put under the prefix.
 *
 * Deprecated fallback: with no options, a secret that is not set under the
 * prefix is read from the unprefixed variable (`SUPPLIER_PASSWORD`), which
 * is where earlier versions looked, and a warning is emitted once per
 * name. The fallback will be removed in a later release. Setting `prefix`
 * turns it off now.
 */
export class EnvVaultResolver implements VaultResolver {
  private readonly prefix: string;
  private readonly allow: ReadonlySet<string> | undefined;
  private readonly fallback: boolean;

  constructor(options: EnvVaultResolverOptions = {}) {
    this.prefix = options.prefix ?? DEFAULT_SECRET_ENV_PREFIX;
    this.allow = options.allow === undefined ? undefined : new Set(options.allow);
    this.fallback = options.prefix === undefined;
  }

  resolve(name: string): string | undefined {
    if (this.allow !== undefined && !this.allow.has(name)) {
      throw new VaultSecretNotAllowedError(name);
    }
    const upper = name.toUpperCase();
    const value = process.env[this.prefix + upper];
    if (!this.fallback || (value !== undefined && value !== '')) return value;

    const legacy = process.env[upper];
    if (legacy === undefined || legacy === '') return value;
    if (!warnedUnprefixed.has(name)) {
      warnedUnprefixed.add(name);
      process.emitWarning(
        `Vault secret '${name}' was read from ${upper}. Reading secrets from unprefixed environment variables is deprecated and will be removed. Set ${DEFAULT_SECRET_ENV_PREFIX}${upper} instead.`,
        { type: 'DeprecationWarning', code: 'SFYSH_UNPREFIXED_SECRET' },
      );
    }
    return legacy;
  }
}

/**
 * Error thrown when a vault secret is missing. Carries the secret name so
 * triage can classify this as auth-decay rather than a site change.
 */
export class VaultSecretMissingError extends Error {
  public readonly secretName: string;

  constructor(name: string) {
    super(`Vault secret not configured: ${name}`);
    this.name = 'VaultSecretMissingError';
    this.secretName = name;
  }
}

/**
 * Error thrown when a workflow asks for a secret that is not on the
 * resolver's allowlist. This is not a missing credential and logging in
 * again will not fix it: the workflow is asking for something it was never
 * given access to, which a person should look at.
 */
export class VaultSecretNotAllowedError extends Error {
  public readonly secretName: string;

  constructor(name: string) {
    super(`Vault secret is not on the allowlist for this run: ${name}`);
    this.name = 'VaultSecretNotAllowedError';
    this.secretName = name;
  }
}
