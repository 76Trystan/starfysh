import { getWorkflow } from './workflow.js';
import type { WorkflowContext } from './context.js';
import { VaultSecretMissingError } from './vault.js';
import { AssertionError } from './assert.js';
import { ExtractionError } from './emit.js';
import { PostconditionViolation } from './conditions.js';

export type FailureKind = 'flake' | 'auth' | 'site' | 'unknown';

export interface RunResult {
  workflowId: string;
  status: 'ok' | 'failed';
  durationMs: number;
  error?: {
    kind: FailureKind;
    message: string;
    cause: unknown;
    /**
     * Step id attributed to the failure. Populated when the thrown error
     * is a `PostconditionViolation` (ADR 0011); undefined otherwise.
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
 * healer, Playwright adapter) can branch on failure kind without wrapping
 * every call in try/catch. The one case that does throw is an unregistered
 * workflow id, which is a programmer error, not a runtime failure.
 *
 * The error classifier here is a placeholder scheduled for removal under
 * ADR 0012 (triage ownership moves to @sfysh/triage).
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
    return {
      workflowId: id,
      status: 'failed',
      durationMs: Date.now() - start,
      error: {
        kind: classifyError(err),
        message: ctx.redact(rawMessage),
        cause: err,
        ...attribution,
      },
    };
  }
}

function classifyError(err: unknown): FailureKind {
  if (err instanceof VaultSecretMissingError) return 'auth';
  if (err instanceof ExtractionError) return 'site';
  if (err instanceof PostconditionViolation) return 'site';
  if (err instanceof AssertionError) return 'site';
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes('timeout') ||
      msg.includes('net::') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('500')
    ) {
      return 'flake';
    }
  }
  return 'unknown';
}
