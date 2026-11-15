import { getWorkflow } from './workflow.js';
import type { WorkflowContext } from './context.js';
import { PostconditionViolation } from './conditions.js';

export interface RunResult {
  workflowId: string;
  status: 'ok' | 'failed';
  durationMs: number;
  error?: {
    /** Error message with registered secrets redacted. Safe to log. */
    message: string;
    /**
     * The raw thrown value, for triage. Sensitive: it is not redacted and
     * may contain secret values. The property is non-enumerable, so
     * `JSON.stringify` and object spread skip it. Do not log it.
     */
    cause: unknown;
    /**
     * Step id attributed to the failure. Populated when the thrown error
     * is a `PostconditionViolation`; undefined otherwise.
     */
    stepId?: string;
    /**
     * Which condition slot failed. Populated alongside `stepId`. `'pre'`
     * means the step's world assumption was wrong before it ran; `'post'`
     * means the step completed but left bad state.
     */
    phase?: 'pre' | 'post';
  };
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
export async function run(id: string, ctx: WorkflowContext): Promise<RunResult> {
  const fn = getWorkflow(id);
  if (fn === undefined) {
    throw new Error(`No workflow registered with id "${id}". Did you import its module?`);
  }

  const start = Date.now();
  try {
    await fn(ctx);
    return { workflowId: id, status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const attribution =
      err instanceof PostconditionViolation ? { stepId: err.stepId, phase: err.phase } : {};
    const error = {
      message: ctx.redact(rawMessage),
      ...attribution,
    } as NonNullable<RunResult['error']>;
    // `cause` is the raw thrown value and can contain secrets (a browser
    // backend may quote a filled value in its error text). Triage needs it,
    // so it stays reachable, but it is non-enumerable so that serialising or
    // spreading a RunResult cannot carry it into a log or a report.
    Object.defineProperty(error, 'cause', { value: err, enumerable: false });
    return {
      workflowId: id,
      status: 'failed',
      durationMs: Date.now() - start,
      error,
    };
  }
}
