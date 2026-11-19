import type { Condition, SelectorCandidate, Step } from '@sfysh/ir';
import type { FailureAttribution } from '@sfysh/runtime';

/**
 * Where a failure should go next.
 *
 * - `flake`: transient. Retry with backoff; no model.
 * - `auth`: the session or credentials are the problem. Re-run login.
 * - `site`: the site changed under the workflow. Wake the healer.
 * - `task`: the task itself changed (the site wants something the IR has no
 *   answer for). The healer drafts, a person must approve.
 * - `unknown`: no rule matched. Escalate to a person.
 *
 * Phase 2 extends this union with `contract_drift` and `deprecation` for
 * the HTTP surface.
 */
export type FailureKind = 'flake' | 'auth' | 'site' | 'task' | 'unknown';

/**
 * Stable code for the rule that produced a classification. Consumers branch
 * and aggregate on this, not on the prose in `reason`.
 */
export type TriageRule =
  /** A postcondition result passed in by the caller was `violated`. */
  | 'postcondition_violated'
  /** A vault secret could not be resolved. */
  | 'vault_secret_missing'
  /** A pre or post condition failed inside the workflow. */
  | 'condition_violated'
  /** An extract step could not read what its schema asked for. */
  | 'extraction_failed'
  /** An `assert` step, or a `wait` that ran out of time, did not hold. */
  | 'assertion_failed'
  /** An element action timed out waiting for its selector. */
  | 'selector_timeout'
  /**
   * A selector matched more than one element, so the backend refused to
   * act (Playwright's "strict mode violation"). The page gained a twin of
   * the element the step meant.
   */
  | 'selector_ambiguous'
  /** The response says a required field was missing (HTTP 400 or 422). */
  | 'required_field_missing'
  /** HTTP 5xx on the response. */
  | 'http_server_error'
  /** HTTP 401 or 403 on the response. */
  | 'http_auth'
  /** A network-level error: connection refused, reset, DNS failure. */
  | 'network_error'
  /** A timeout with no element involved: navigation, or a run or step time limit. */
  | 'timeout'
  /** Nothing matched. */
  | 'no_rule';

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
  /**
   * Where the failure happened, as reported on `RunResult.error` or
   * `ReplayOutcome.error`. Either object can be passed as is. Triage uses it
   * to tell an element timeout from a navigation timeout and copies it onto
   * the result.
   */
  attribution?: FailureAttribution;
  /**
   * IR step attributed to the failure, when known. Used as a fallback
   * source for the step id, action and selector when `attribution` is not
   * given.
   */
  step?: Step;
  /** Postcondition results evaluated by the caller. A `violated` entry forces `site`. */
  postconditions?: PostconditionResult[];
  /** HTTP response metadata, present only for request-step failures (Phase 2). */
  response?: TriageResponse;
}

export interface ClassifyResult {
  kind: FailureKind;
  /** Which rule fired. Stable; safe to branch on. */
  rule: TriageRule;
  /** Short human description of which rule fired. For logs, not for branching. */
  reason: string;
  /**
   * Whether a plain retry is worth trying before anything else. True for
   * every `flake`, and for a `site` failure caused by a selector timeout,
   * where one retry separates a slow page from a changed one.
   */
  retryable: boolean;
  /** IR step the failure is attributed to, when known. */
  stepId?: string;
  /** Action kind of that step. */
  action?: string;
  /** Selector candidate the step was using. */
  selector?: SelectorCandidate;
  /** Condition slot that failed, when a condition was violated. */
  phase?: 'pre' | 'post';
  /** The violated condition. */
  condition?: Condition;
}
