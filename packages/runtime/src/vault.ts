// Secret resolution for generated workflows.
//
// Generated code calls `vault('supplier_portal_password')` instead of inlining
// the literal secret. The default resolver reads from process.env with the
// name upper-cased. Downstream integrations (Doppler, AWS Secrets Manager,
// HashiCorp Vault) register a custom resolver via setVaultResolver.

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

let currentResolver: VaultResolver = new EnvVaultResolver();

/**
 * Replace the active vault resolver. Call this once at process start,
 * before any generated workflow runs. The runtime does not synchronise
 * resolver swaps mid-run.
 */
export function setVaultResolver(resolver: VaultResolver): void {
  currentResolver = resolver;
}

/**
 * Resolve a vault secret by name. Throws if the secret is not configured;
 * generated code never catches this error, so a missing secret fails the
 * workflow loudly rather than running with an empty string.
 */
export function vault(name: string): string {
  const value = currentResolver.resolve(name);
  if (value === undefined || value === '') {
    throw new VaultSecretMissingError(name);
  }
  return value;
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
