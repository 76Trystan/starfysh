// N-run replay loop. One call to replay() produces one VerifyReport covering
// every replay, including per-run timing, outputs, and postcondition
// evaluation of the workflow's terminal step.

import type { Workflow } from '@sfysh/ir';
import { createWorkflowContext, type WorkflowContext } from '@sfysh/runtime';
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

export interface ReplayFromCassetteOptions {
  runner: RunnerFn;
  runs?: number;
  tolerance?: ToleranceMap;
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
    ...(options.vaultResolver ? { vaultResolver: options.vaultResolver } : {}),
  });

  const start = Date.now();
  let error: ReplayOutcome['error'];
  try {
    await options.runner(ctx, workflow);
  } catch (err) {
    error = {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : 'Error',
    };
  }
  const durationMs = Date.now() - start;

  const outputs = ctx.drainOutputs();

  let postconditions: PostconditionResult[] = [];
  if (!error && terminalPost.length > 0) {
    try {
      postconditions = await evaluateConditions(ctx.page, [...terminalPost]);
    } catch (err) {
      error = {
        message: `Postcondition evaluation threw: ${err instanceof Error ? err.message : String(err)}`,
        name: err instanceof Error ? err.name : 'Error',
      };
    }
  }

  if (options.dispose) {
    try {
      await options.dispose(ctx);
    } catch {
      // Disposer failures are not replay failures; swallow to keep the
      // outcome shape clean. A noisy disposer belongs in the caller's logs.
    }
  }

  const violated = postconditions.some((p) => p.status === 'violated');
  const status: ReplayOutcome['status'] = error || violated ? 'failed' : 'ok';

  return {
    index,
    status,
    durationMs,
    outputs,
    postconditions,
    ...(error ? { error } : {}),
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
