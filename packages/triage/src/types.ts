import type { Condition, Step } from '@sfysh/ir';

/**
 * Discriminator returned by {@link classify}. Phase 2 extends this union with
 * `contract_drift` and `deprecation` for the HTTP surface.
 */
export type FailureKind = 'flake' | 'auth' | 'site' | 'unknown';

/**
 * One postcondition evaluation, as the caller observed it. Structurally
 * compatible with the verifier's PostconditionResult so callers can pass
 * verifier output straight through.
 */
export interface PostconditionResult {
  condition: Condition;
  status: 'held' | 'violated' | 'unsupported';
  reason?: string;
}

/**
 * HTTP response metadata for Phase 2 request-step classification. Browser
 * triage ignores this field. Kept minimal so the shape lands with the
 * `request` action rather than guessing it up front.
 */
export interface TriageResponse {
  status: number;
  headers?: Record<string, string>;
}

export interface ClassifyInput {
  /** The raw thrown error. Not scrubbed; triage runs on raw cause data. */
  error: unknown;
  /** IR step attributed to the failure, when known. Enables step-aware rules in future. */
  step?: Step;
  /** Postcondition results evaluated by the caller. A `violated` entry forces `site`. */
  postconditions?: PostconditionResult[];
  /** HTTP response metadata, present only for request-step failures (Phase 2). */
  response?: TriageResponse;
}

export interface ClassifyResult {
  kind: FailureKind;
  /** Short human description of which rule fired. Downstream consumers log it as-is. */
  reason: string;
}
