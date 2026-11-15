import type { Condition, SelectorCandidate } from '@sfysh/ir';
import { getWorkflow } from './workflow.js';
import type { WorkflowContext } from './context.js';
import { describeFailure } from './step.js';
import { capturePageSnapshot, type PageSnapshot, type SnapshotOptions } from './snapshot.js';

export interface RunResult {
  workflowId: string;
  status: 'ok' | 'failed';
  durationMs: number;
  error?: {
    /** Name of the original error (`TimeoutError`, `ExtractionError`, ...). */
    name: string;
    /** Error message with registered secrets redacted. Safe to log. */
    message: string;
    /**
     * The raw thrown value, for triage. Sensitive: it is not redacted and
     * may contain secret values. The property is non-enumerable, so
     * `JSON.stringify` and object spread skip it. Do not log it.
     */
    cause: unknown;
    /**
     * IR step that was running when the failure happened. Populated for any
     * failure inside generated code, and for a `PostconditionViolation`
     * thrown anywhere. Undefined when a hand-written workflow fails outside
     * a `step()` wrapper.
     */
    stepId?: string;
    /** Action kind of the failing step (`click`, `fill`, ...). */
    action?: string;
    /** Selector candidate the failing step was using, if it had a target. */
    selector?: SelectorCandidate;
    /**
     * Which condition slot failed. `'pre'` means the step's world
     * assumption was wrong before it ran; `'post'` means the step completed
     * but left bad state. Undefined when the step body itself threw.
     */
    phase?: 'pre' | 'post';
    /** The violated condition. Populated alongside `phase`. */
    condition?: Condition;
    /** Why the condition did not hold. Populated alongside `phase`. */
    reason?: string;
  };
  /**
   * Accessibility snapshot of the page taken right after a failure, when
   * the backend supports it. Untrusted page content, with registered
   * secrets redacted and the length capped.
   */
  snapshot?: PageSnapshot;
}

export interface RunOptions {
  /**
   * Capture a page snapshot when the run fails. Default true. Pass `false`
   * to skip it, or an options object to change the size cap or timeout.
   */
  snapshot?: boolean | SnapshotOptions;
}

/**
 * Execute a registered workflow against a WorkflowContext.
 *
 * Returns a structured result instead of throwing so callers (scheduler,
 * healer, Playwright adapter) can branch on failure without wrapping
 * every call in try/catch. The one case that does throw is an unregistered
 * workflow id, which is a programmer error, not a runtime failure.
 *
 * Classification of the failure into a `FailureKind` is the caller's job via
 * `@sfysh/triage`. The runtime only reports the raw shape.
 */
export async function run(
  id: string,
  ctx: WorkflowContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const fn = getWorkflow(id);
  if (fn === undefined) {
    throw new Error(`No workflow registered with id "${id}". Did you import its module?`);
  }

  const start = Date.now();
  try {
    await fn(ctx);
    return { workflowId: id, status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    const durationMs = Date.now() - start;
    const failure = describeFailure(ctx, err);
    const error = {
      name: failure.name,
      message: failure.message,
      ...failure.attribution,
    } as NonNullable<RunResult['error']>;
    // `cause` is the raw thrown value and can contain secrets (a browser
    // backend may quote a filled value in its error text). Triage needs it,
    // so it stays reachable, but it is non-enumerable so that serialising or
    // spreading a RunResult cannot carry it into a log or a report.
    Object.defineProperty(error, 'cause', { value: failure.cause, enumerable: false });

    const snapshot =
      options.snapshot === false
        ? undefined
        : await capturePageSnapshot(
            ctx,
            typeof options.snapshot === 'object' ? options.snapshot : {},
          );

    return {
      workflowId: id,
      status: 'failed',
      durationMs,
      error,
      ...(snapshot ? { snapshot } : {}),
    };
  }
}
