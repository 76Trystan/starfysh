// Secret resolution types.
//
// The `vault(name)` helper that generated code calls is bound to the
// per-run WorkflowContext (ADR 0010). This module exposes the pluggable
// VaultResolver interface, the default EnvVaultResolver, and the
// VaultSecretMissingError thrown when a secret is unavailable.

export interface VaultResolver {
  resolve(name: string): string | undefined;
}

/**
 * The default resolver. Looks up `name` in process.env after upper-casing.
 * `supplier_portal_password` -> `process.env.SUPPLIER_PORTAL_PASSWORD`.
 */
export class EnvVaultResolver implements VaultResolver {
  resolve(name: string): string | undefined {
    return process.env[name.toUpperCase()];
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
