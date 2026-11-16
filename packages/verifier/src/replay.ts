// N-run replay loop. One call to replay() produces one VerifyReport covering
// every replay, including per-run timing, outputs, and postcondition
// evaluation of the workflow's terminal step.

import type { Workflow } from '@sfysh/ir';
import {
  capturePageSnapshot,
  createWorkflowContext,
  describeFailure,
  EnvVaultResolver,
  getWorkflow,
  type PageSnapshot,
  type WorkflowContext,
} from '@sfysh/runtime';
import type { Cassette } from './cassette.js';
import { fakePageFromCassette } from './fake-page.js';
import { evaluateConditions } from './postconditions.js';
import { compareOutputs } from './stability.js';
import type {
  PostconditionResult,
  ReplayOutcome,
  RunnerFn,
  TimingEnvelope,
  ToleranceMap,
  VerifyOptions,
  VerifyReport,
} from './types.js';

/**
 * A ready-made runner for compiled workflows. Looks up the workflow that
 * generated code registered under workflow.id and executes it directly,
 * so a failure reaches the verifier with its step attribution intact.
 *
 * Prefer this over a runner that calls run() from @sfysh/runtime and
 * re-throws: run() reports failures as a result object, and re-throwing
 * its raw cause drops the step id and selector.
 */
export const runRegisteredWorkflow: RunnerFn = async (ctx, workflow) => {
  const fn = getWorkflow(workflow.id);
  if (fn === undefined) {
    throw new Error(
      `No workflow registered with id "${workflow.id}". Did you import its compiled module?`,
    );
  }
  await fn(ctx);
};

/** Recorded as the error of a replay that ran past `VerifyOptions.runTimeoutMs`. */
export class RunTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`run timed out after ${timeoutMs}ms`);
    this.name = 'RunTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Await the runner, giving up after `timeoutMs`. A missing or zero timeout
 * means no limit.
 */
async function runWithTimeout(work: Promise<void>, timeoutMs: number | undefined): Promise<void> {
  if (!timeoutMs || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // If the timeout wins, the runner may still reject later with nobody listening.
  work.catch(() => {});
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RunTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ReplayFromCassetteOptions {
  runner: RunnerFn;
  runs?: number;
  tolerance?: ToleranceMap;
  runTimeoutMs?: number;
}

/**
 * Replay a workflow against a cassette instead of a live Page backend. The
 * runner executes unchanged; FakePage returns the recorded answer for every
 * query. Useful for regression testing, healer scoring loops, and CI runs
 * that cannot reach the open internet.
 */
export async function replayFromCassette(
  workflow: Workflow,
  cassette: Cassette,
  options: ReplayFromCassetteOptions,
): Promise<VerifyReport> {
  return replay(workflow, {
    pageFactory: () => fakePageFromCassette(cassette),
    runner: options.runner,
    ...(options.runs !== undefined ? { runs: options.runs } : {}),
    ...(options.tolerance ? { tolerance: options.tolerance } : {}),
    ...(options.runTimeoutMs !== undefined ? { runTimeoutMs: options.runTimeoutMs } : {}),
  });
}

export async function replay(workflow: Workflow, options: VerifyOptions): Promise<VerifyReport> {
  const runs = Math.max(1, options.runs ?? 3);
  const terminalPost = terminalPostconditions(workflow);

  const outcomes: ReplayOutcome[] = [];
  for (let i = 0; i < runs; i++) {
    outcomes.push(await runOnce(i, workflow, terminalPost, options));
  }

  const passed = outcomes.filter((o) => o.status === 'ok').length;
  const stability = compareOutputs(
    outcomes.map((o) => o.outputs),
    options.tolerance,
  );
  const timing = buildTiming(outcomes.map((o) => o.durationMs));

  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    runs,
    passed,
    failed: runs - passed,
    stability,
    timing,
    replays: outcomes,
  };
}

async function runOnce(
  index: number,
  workflow: Workflow,
  terminalPost: readonly PostconditionResult['condition'][],
  options: VerifyOptions,
): Promise<ReplayOutcome> {
  const page = await options.pageFactory();
  const ctx: WorkflowContext = createWorkflowContext({
    page,
    // The default resolver is limited to the secrets this workflow declares,
    // so a runner cannot read an environment variable the workflow never
    // asked for. A resolver supplied by the caller is used as it is.
    vaultResolver: options.vaultResolver ?? new EnvVaultResolver({ allow: workflow.secrets ?? [] }),
  });

  const start = Date.now();
  let error: ReplayOutcome['error'];
  try {
    await runWithTimeout(options.runner(ctx, workflow), options.runTimeoutMs);
  } catch (err) {
    const failure = describeFailure(ctx, err);
    error = {
      message: failure.message,
      name: failure.name,
      ...failure.attribution,
    };
    // Kept for in-process triage only. Non-enumerable so the raw error,
    // which is not redacted, cannot leak through a reporter.
    Object.defineProperty(error, 'cause', { value: failure.cause, enumerable: false });
  }
  const durationMs = Date.now() - start;

  const outputs = ctx.drainOutputs();

  let postconditions: PostconditionResult[] = [];
  if (!error && terminalPost.length > 0) {
    try {
      postconditions = await evaluateConditions(ctx.page, [...terminalPost]);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      error = {
        message: ctx.redact(`Postcondition evaluation threw: ${rawMessage}`),
        name: err instanceof Error ? err.name : 'Error',
      };
    }
  }

  const violated = postconditions.some((p) => p.status === 'violated');
  const status: ReplayOutcome['status'] = error || violated ? 'failed' : 'ok';

  // Capture what the page looked like while it is still open. The disposer
  // below usually closes it.
  let snapshot: PageSnapshot | undefined;
  if (status === 'failed' && options.snapshot !== false) {
    snapshot = await capturePageSnapshot(
      ctx,
      typeof options.snapshot === 'object' ? options.snapshot : {},
    );
  }

  if (options.dispose) {
    try {
      await options.dispose(ctx);
    } catch {
      // Disposer failures are not replay failures; swallow to keep the
      // outcome shape clean. A noisy disposer belongs in the caller's logs.
    }
  }

  return {
    index,
    status,
    durationMs,
    outputs,
    postconditions,
    ...(error ? { error } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
}

function terminalPostconditions(workflow: Workflow): PostconditionResult['condition'][] {
  const last = workflow.steps[workflow.steps.length - 1];
  return last?.post ?? [];
}

function buildTiming(samples: number[]): TimingEnvelope {
  if (samples.length === 0) {
    return { minMs: 0, maxMs: 0, meanMs: 0, samples: [] };
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { minMs: min, maxMs: max, meanMs: mean, samples: samples.slice() };
}
