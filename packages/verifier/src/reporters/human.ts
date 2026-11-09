// Compact human-readable verifier report. Written for a developer scanning
// terminal output, not a dashboard. Keep it one screen when there is nothing
// interesting to report; expand only when something broke.

import type { VerifyReport } from '../types.js';

export function humanReport(report: VerifyReport): string {
  const lines: string[] = [];
  const header = `${report.workflowName} (${report.workflowId})`;
  lines.push(header);
  lines.push('-'.repeat(header.length));
  lines.push(
    `Runs: ${report.runs}   Passed: ${report.passed}   Failed: ${report.failed}   ` +
      `Timing: min ${fmtMs(report.timing.minMs)} / mean ${fmtMs(report.timing.meanMs)} / max ${fmtMs(
        report.timing.maxMs,
      )}`,
  );

  lines.push(`Stability: ${report.stability.stable ? 'stable' : 'drift detected'}`);
  if (!report.stability.stable) {
    for (const d of report.stability.drift) {
      lines.push(`  drift at '${d.path}': ${d.values.map((v) => shortJson(v)).join(' vs ')}`);
    }
  }

  for (const r of report.replays) {
    const status = r.status === 'ok' ? 'ok' : 'FAILED';
    lines.push(`  run ${r.index + 1}: ${status} in ${fmtMs(r.durationMs)}`);
    if (r.error) {
      lines.push(`    error: ${r.error.name}: ${r.error.message}`);
    }
    const violated = r.postconditions.filter((p) => p.status === 'violated');
    for (const p of violated) {
      lines.push(`    postcondition violated: ${p.reason ?? JSON.stringify(p.condition)}`);
    }
    const unsupported = r.postconditions.filter((p) => p.status === 'unsupported');
    if (unsupported.length > 0) {
      lines.push(`    (${unsupported.length} postcondition(s) unsupported by current Page)`);
    }
  }

  return lines.join('\n') + '\n';
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function shortJson(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  if (s.length <= 60) return s;
  return s.slice(0, 57) + '...';
}
