// N-run replay loop. One call to replay() produces one VerifyReport covering
// every replay, including per-run timing, outputs, and postcondition
// evaluation of the workflow's terminal step.

import type { Workflow } from '@sfysh/ir';
import { drainOutputs } from '@sfysh/runtime';
import { evaluateConditions } from './postconditions.js';
import { compareOutputs } from './stability.js';
import type {
  PostconditionResult,
  ReplayOutcome,
  TimingEnvelope,
  VerifyOptions,
  VerifyReport,
} from './types.js';

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
  // Drain any outputs left over from a previous replay so this run's
  // outputs are captured in isolation. drainOutputs is idempotent on an
  // empty buffer.
  drainOutputs();

  const page = await options.pageFactory();
  const start = Date.now();
  let error: ReplayOutcome['error'];
  try {
    await options.runner(page, workflow);
  } catch (err) {
    error = {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : 'Error',
    };
  }
  const durationMs = Date.now() - start;

  const outputs = drainOutputs();

  let postconditions: PostconditionResult[] = [];
  if (!error && terminalPost.length > 0) {
    try {
      postconditions = await evaluateConditions(page, [...terminalPost]);
    } catch (err) {
      error = {
        message: `Postcondition evaluation threw: ${err instanceof Error ? err.message : String(err)}`,
        name: err instanceof Error ? err.name : 'Error',
      };
    }
  }

  if (options.dispose) {
    try {
      await options.dispose(page);
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
