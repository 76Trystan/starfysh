// Branded Secret string type. Introduced by ADR 0013.
//
// The brand is a phantom type: zero runtime cost, structural compatibility
// with string in one direction (Secret -> string, widening always allowed),
// friction in the other direction (string -> Secret requires `asSecret`).
//
// The hard redaction guarantee comes from routing output through the
// per-run `ctx.redact` scrubber defined in context.ts. The brand is a
// soft signal that lets future linting flag direct stringification or
// template-literal interpolation of a Secret value.

declare const secretBrand: unique symbol;

/**
 * A branded string returned by `ctx.vault(name)`. Functionally identical
 * to a `string` at runtime (so it can be passed to `locator.fill`,
 * `Buffer.from`, etc.), but TypeScript tracks it as distinct so suspicious
 * patterns can be flagged without touching the call graph.
 */
export type Secret = string & { readonly [secretBrand]: 'Secret' };

/**
 * Cast a plain string into a `Secret`. The only intended caller is
 * `ctx.vault(name)` inside `createWorkflowContext`; external callers that
 * reach for this function should prefer declaring a vault resolver that
 * owns the mapping instead.
 */
export function asSecret(value: string): Secret {
  return value as Secret;
}
