// Public types for the verifier. Shaped so a healer can read a report
// and decide "has this patch stabilised the workflow?" without caring
// how the workflow was executed.

import type { Condition, Workflow } from '@sfysh/ir';
import type { Page } from '@sfysh/runtime';

/**
 * Callback that executes a workflow once against a given Page. Returning
 * normally means "the workflow ran to completion"; throwing means it
 * failed and the thrown error is attached to the replay result.
 */
export type RunnerFn = (page: Page, workflow: Workflow) => Promise<void>;

/**
 * Factory invoked once per replay to produce a fresh Page. Fresh sessions
 * are load-bearing: a stateful page across runs would let a replay inherit
 * side effects (logged-in state, cached data) from the previous run and
 * mask failures.
 */
export type PageFactory = () => Page | Promise<Page>;

/**
 * Optional disposer invoked after each replay. Used to close pages, release
 * browser contexts, or flush logs. A thrown disposer error is recorded but
 * does not count as a replay failure.
 */
export type PageDisposer = (page: Page) => void | Promise<void>;

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
