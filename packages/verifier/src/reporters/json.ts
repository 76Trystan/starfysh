// JSON reporter. Stable, machine-readable shape consumers can diff across
// verifier runs. Field order is fixed so byte-level diffs across runs
// highlight real changes rather than key reordering.

import type { VerifyReport } from '../types.js';

export function jsonReport(report: VerifyReport, indent: number = 2): string {
  const normalised = {
    workflowId: report.workflowId,
    workflowName: report.workflowName,
    runs: report.runs,
    passed: report.passed,
    failed: report.failed,
    stability: report.stability,
    timing: report.timing,
    replays: report.replays.map((r) => ({
      index: r.index,
      status: r.status,
      durationMs: r.durationMs,
      outputs: r.outputs,
      postconditions: r.postconditions,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
  return JSON.stringify(normalised, null, indent);
}
