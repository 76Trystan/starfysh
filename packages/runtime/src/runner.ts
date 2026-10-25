import { getWorkflow } from './workflow.js';
import type { Page } from './types.js';
import { VaultSecretMissingError } from './vault.js';
import { AssertionError } from './assert.js';
import { ExtractionError } from './emit.js';

export type FailureKind = 'flake' | 'auth' | 'site' | 'unknown';

export interface RunResult {
  workflowId: string;
  status: 'ok' | 'failed';
  durationMs: number;
  error?: {
    kind: FailureKind;
    message: string;
    cause: unknown;
  };
}

/**
 * Execute a registered workflow against the given Page implementation.
 *
 * Returns a structured result instead of throwing so callers (scheduler,
 * healer) can branch on failure kind without wrapping every call in
 * try/catch. The one case that does throw is an unregistered workflow id,
 * which is a programmer error, not a runtime failure.
 */
export async function run(id: string, page: Page): Promise<RunResult> {
  const fn = getWorkflow(id);
  if (fn === undefined) {
    throw new Error(`No workflow registered with id "${id}". Did you import its module?`);
  }

  const start = Date.now();
  try {
    await fn(page);
    return { workflowId: id, status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    return {
      workflowId: id,
      status: 'failed',
      durationMs: Date.now() - start,
      error: {
        kind: classifyError(err),
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      },
    };
  }
}

function classifyError(err: unknown): FailureKind {
  if (err instanceof VaultSecretMissingError) return 'auth';
  if (err instanceof ExtractionError) return 'site';
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
