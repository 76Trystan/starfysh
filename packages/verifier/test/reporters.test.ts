import { describe, it, expect } from 'vitest';
import { humanReport, jsonReport } from '../src/index.js';
import type { VerifyReport } from '../src/types.js';

const okReport: VerifyReport = {
  workflowId: 'wf_1',
  workflowName: 'Wf 1',
  runs: 2,
  passed: 2,
  failed: 0,
  stability: { stable: true, drift: [] },
  timing: { minMs: 10, maxMs: 20, meanMs: 15, samples: [10, 20] },
  replays: [
    { index: 0, status: 'ok', durationMs: 10, outputs: [], postconditions: [] },
    { index: 1, status: 'ok', durationMs: 20, outputs: [], postconditions: [] },
  ],
};

const failedReport: VerifyReport = {
  workflowId: 'wf_2',
  workflowName: 'Wf 2',
  runs: 2,
  passed: 1,
  failed: 1,
  stability: { stable: false, drift: [{ path: '0.price', values: [10, 11] }] },
  timing: { minMs: 100, maxMs: 2500, meanMs: 1300, samples: [100, 2500] },
  replays: [
    { index: 0, status: 'ok', durationMs: 100, outputs: [{ price: 10 }], postconditions: [] },
    {
      index: 1,
      status: 'failed',
      durationMs: 2500,
      outputs: [{ price: 11 }],
      postconditions: [
        {
          condition: { urlMatches: '/done' },
          status: 'violated',
          reason: "URL '...' did not match",
        },
        { condition: { responseStatus: 200 }, status: 'unsupported' },
      ],
      error: { name: 'Error', message: 'something broke' },
    },
  ],
};

describe('humanReport', () => {
  it('renders a one-screen summary for a clean run', () => {
    const out = humanReport(okReport);
    expect(out).toContain('Wf 1 (wf_1)');
    expect(out).toContain('Runs: 2');
    expect(out).toContain('Stability: stable');
    expect(out).not.toContain('FAILED');
  });

  it('surfaces drift paths when outputs diverge', () => {
    const out = humanReport(failedReport);
    expect(out).toContain("drift at '0.price'");
    expect(out).toContain('10 vs 11');
  });

  it('shows errors and postcondition violations for failed runs', () => {
    const out = humanReport(failedReport);
    expect(out).toContain('run 2: FAILED');
    expect(out).toContain('error: Error: something broke');
    expect(out).toContain('postcondition violated');
    expect(out).toContain('1 postcondition(s) unsupported');
  });

  it('formats timing in seconds above 1000ms', () => {
    const out = humanReport(failedReport);
    expect(out).toContain('2.50s');
  });
});

describe('jsonReport', () => {
  it('serialises with stable key order', () => {
    const a = jsonReport(okReport);
    const b = jsonReport(okReport);
    expect(a).toBe(b);
  });

  it('round-trips through JSON.parse', () => {
    const parsed = JSON.parse(jsonReport(failedReport));
    expect(parsed.workflowId).toBe('wf_2');
    expect(parsed.replays[1].error.message).toBe('something broke');
  });

  it('omits the error field when a replay succeeded', () => {
    const parsed = JSON.parse(jsonReport(okReport));
    expect(parsed.replays[0]).not.toHaveProperty('error');
  });
});
