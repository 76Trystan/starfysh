// Public types for the verifier. Shaped so a healer can read a report
// and decide "has this patch stabilised the workflow?" without caring
// how the workflow was executed.

import type { Condition, Workflow } from '@sfysh/ir';
import type { Page, VaultResolver, WorkflowContext } from '@sfysh/runtime';

/**
 * Callback that executes a workflow once against a prepared WorkflowContext.
 * Returning normally means "the workflow ran to completion"; throwing means
 * it failed and the thrown error is attached to the replay result.
 *
 * Signature changed under ADR 0010 from `(page, workflow)` to
 * `(ctx, workflow)`. The verifier constructs the context from the backend's
 * pageFactory output before calling the runner.
 */
export type RunnerFn = (ctx: WorkflowContext, workflow: Workflow) => Promise<void>;

/**
 * Factory invoked once per replay to produce a fresh Page. Fresh sessions
 * are load-bearing: a stateful page across runs would let a replay inherit
 * side effects (logged-in state, cached data) from the previous run and
 * mask failures.
 */
export type PageFactory = () => Page | Promise<Page>;

/**
 * Optional disposer invoked after each replay. Receives the per-run
 * context so adapters can clean up their own state (close the page, flush
 * logs) while still being able to reach `ctx.page` directly.
 */
export type PageDisposer = (ctx: WorkflowContext) => void | Promise<void>;

/**
 * Optional vault resolver passed through from the backend module. Threaded
 * into `createWorkflowContext` so `ctx.vault(name)` resolves against the
 * backend's chosen secret source. Defaults to the EnvVaultResolver when
 * absent.
 */
export type VaultResolverFactory = VaultResolver;

/**
 * Per-field tolerance rules when comparing outputs across runs. The key
 * is a dotted field path within an output row ("rows.0.price",
 * "metadata.timestamp"); a leading "*" wildcards a segment.
 */
export type ToleranceMap = Record<string, ToleranceRule>;

/**
 * How a single field should be compared across runs.
 *
 * - "ignore": skip this field entirely (useful for timestamps, request ids).
 * - "equal": default; values must be strictly deep-equal.
 * - { kind: "number", epsilon }: numeric equality within +/- epsilon.
 * - { kind: "set" }: array compared as a set (order-insensitive).
 */
export type ToleranceRule =
  'ignore' | 'equal' | { kind: 'number'; epsilon: number } | { kind: 'set' };

export interface VerifyOptions {
  pageFactory: PageFactory;
  runner: RunnerFn;
  /**
   * Number of replays. Default 3. The verifier always runs at least one
   * replay, even if `runs` is set lower.
   */
  runs?: number;
  dispose?: PageDisposer;
  /**
   * Per-field tolerance when comparing outputs. Fields not listed default
   * to strict deep equality.
   */
  tolerance?: ToleranceMap;
  /**
   * Vault resolver passed through to each run's WorkflowContext. Defaults
   * to `EnvVaultResolver` when absent.
   */
  vaultResolver?: VaultResolver;
}

export interface TimingEnvelope {
  minMs: number;
  maxMs: number;
  meanMs: number;
  samples: number[];
}

export interface PostconditionResult {
  condition: Condition;
  /**
   * 'held': condition is true against the live page.
   * 'violated': condition is false; this is a real failure the healer would triage.
   * 'unsupported': the verifier cannot evaluate this condition from a Page alone
   *   (e.g. responseStatus needs a navigation observer), so the result is
   *   neither a pass nor a failure.
   */
  status: 'held' | 'violated' | 'unsupported';
  /** Present when `status` is not 'held'; a short description of why. */
  reason?: string;
}

export interface ReplayOutcome {
  index: number;
  status: 'ok' | 'failed';
  durationMs: number;
  outputs: unknown[];
  postconditions: PostconditionResult[];
  error?: {
    message: string;
    name: string;
    /**
     * Step id attributed to the failure when the thrown error is a
     * `PostconditionViolation` (ADR 0011). Undefined otherwise.
     */
    stepId?: string;
    /** Condition slot that failed. Populated alongside `stepId`. */
    phase?: 'pre' | 'post';
  };
}

/**
 * Describes a single field that drifted across replays.
 * `path` is the dotted field path, `values` is the distinct values observed.
 */
export interface DriftField {
  path: string;
  values: unknown[];
}

export interface StabilityReport {
  stable: boolean;
  drift: DriftField[];
}

export interface VerifyReport {
  workflowId: string;
  workflowName: string;
  runs: number;
  passed: number;
  failed: number;
  stability: StabilityReport;
  timing: TimingEnvelope;
  replays: ReplayOutcome[];
}
