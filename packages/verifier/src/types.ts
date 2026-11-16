// Public types for the verifier. Shaped so a healer can read a report
// and decide "has this patch stabilised the workflow?" without caring
// how the workflow was executed.

import type { Condition, SelectorCandidate, Workflow } from '@sfysh/ir';
import type {
  Page,
  PageSnapshot,
  SnapshotOptions,
  VaultResolver,
  WorkflowContext,
} from '@sfysh/runtime';

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
   * to an `EnvVaultResolver` limited to the names in `workflow.secrets`
   * when absent.
   */
  vaultResolver?: VaultResolver;
  /**
   * Capture a page snapshot when a replay fails. Default true. Pass false
   * to skip it, or an options object to change the size cap or timeout.
   */
  snapshot?: boolean | SnapshotOptions;
  /**
   * Longest a single replay may take, in milliseconds. When it is exceeded
   * the replay is recorded as failed with a `RunTimeoutError` and the
   * verifier moves on. No limit when omitted. The runner cannot be
   * cancelled, so it may still be working against the page when the
   * disposer runs; a disposer that closes the page ends it.
   */
  runTimeoutMs?: number;
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
    /** Error message with registered secrets redacted. */
    message: string;
    /** Name of the original error (TimeoutError, ExtractionError, ...). */
    name: string;
    /**
     * IR step that was running when the replay failed. Populated for any
     * failure inside generated code and for a PostconditionViolation
     * thrown anywhere. Undefined when the runner failed outside a step.
     */
    stepId?: string;
    /** Action kind of the failing step. */
    action?: string;
    /** Selector candidate the failing step was using, if it had a target. */
    selector?: SelectorCandidate;
    /** Condition slot that failed, when a pre or post condition was violated. */
    phase?: 'pre' | 'post';
    /** The violated condition. Populated alongside phase. */
    condition?: Condition;
    /** Why the condition did not hold. Populated alongside phase. */
    reason?: string;
    /**
     * The raw thrown value, for @sfysh/triage. Not redacted. The property
     * is non-enumerable, so reporters and JSON.stringify skip it. Present
     * only in-process; it does not survive serialisation.
     */
    cause?: unknown;
  };
  /**
   * Accessibility snapshot of the page taken right after a failed replay,
   * when the backend supports it. Untrusted page content, redacted and
   * capped in length. Not included in the JSON report.
   */
  snapshot?: PageSnapshot;
}

/**
 * Describes a single field that drifted across replays.
 * `path` is the dotted field path, `values` is the distinct values observed.
 * `missing` is true when at least one run did not produce the field at all,
 * which `values` cannot show because an absent value has no JSON form.
 */
export interface DriftField {
  path: string;
  values: unknown[];
  missing?: boolean;
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
