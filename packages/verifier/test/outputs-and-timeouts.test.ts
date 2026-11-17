// Output stability when runs disagree about which fields exist, the
// per-run time limit, and outputs produced by interpreted extract steps.

import { describe, it, expect } from 'vitest';
import type { Workflow } from '@sfysh/ir';
import { createWorkflowContext, StepFailure } from '@sfysh/runtime';
import {
  compareOutputs,
  humanReport,
  InterpreterError,
  interpretWorkflow,
  jsonReport,
  replay,
  RunTimeoutError,
} from '../src/index.js';
import { loggingPage } from './helpers/logging-page.js';

describe('compareOutputs: fields present in one run and absent in another', () => {
  it('reports the field as drift instead of throwing', () => {
    const report = compareOutputs([[{ a: 1, b: 2 }], [{ a: 1 }]]);
    expect(report).toEqual({
      stable: false,
      drift: [{ path: '0.b', values: [2], missing: true }],
    });
  });

  it('handles the field appearing in a later run', () => {
    const report = compareOutputs([[{ a: 1 }], [{ a: 1, b: 'new' }], [{ a: 1, b: 'new' }]]);
    expect(report.drift).toEqual([{ path: '0.b', values: ['new'], missing: true }]);
  });

  it('tells an absent field apart from an explicit null', () => {
    const report = compareOutputs([[{ a: null }], [{}]]);
    expect(report.drift).toEqual([{ path: '0.a', values: [null], missing: true }]);
  });

  it('does not mark ordinary drift as missing', () => {
    const report = compareOutputs([[{ a: 1 }], [{ a: 2 }]]);
    expect(report.drift).toEqual([{ path: '0.a', values: [1, 2] }]);
  });

  it('handles a nested object that is missing entirely', () => {
    const report = compareOutputs([[{ row: { sku: 'A' } }], [{}]]);
    expect(report.drift).toEqual([{ path: '0.row', values: [{ sku: 'A' }], missing: true }]);
  });

  it('survives the reporters', () => {
    const base = {
      workflowId: 'wf',
      workflowName: 'Workflow',
      runs: 2,
      passed: 2,
      failed: 0,
      timing: { minMs: 1, maxMs: 1, meanMs: 1, samples: [1, 1] },
      replays: [],
    };
    const report = { ...base, stability: compareOutputs([[{ a: 1, b: 2 }], [{ a: 1 }]]) };
    expect(humanReport(report)).toContain("drift at '0.b': 2 vs (absent)");
    const parsed = JSON.parse(jsonReport(report)) as { stability: { drift: unknown[] } };
    expect(parsed.stability.drift).toEqual([{ path: '0.b', values: [2], missing: true }]);
  });
});

const wf = (steps: unknown[], extra: Record<string, unknown> = {}): Workflow =>
  ({
    irVersion: '1.0.0',
    id: 'wf_outputs',
    name: 'Outputs',
    steps,
    ...extra,
  }) as unknown as Workflow;

describe('replay: per-run time limit', () => {
  it('fails a replay that runs past runTimeoutMs and moves on to the next', async () => {
    let calls = 0;
    const started = Date.now();
    const report = await replay(
      wf([{ id: 'nav_001', intent: 'Open.', action: 'navigate', url: 'https://x.test/' }]),
      {
        pageFactory: () => loggingPage({ snapshot: '- still loading' }).page,
        runs: 2,
        runTimeoutMs: 40,
        runner: () => {
          calls++;
          return new Promise<void>(() => {});
        },
      },
    );

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(calls).toBe(2);
    expect(report.failed).toBe(2);
    expect(report.replays[0]?.error).toMatchObject({
      name: 'RunTimeoutError',
      message: 'run timed out after 40ms',
    });
    expect(report.replays[0]?.error?.cause).toBeInstanceOf(RunTimeoutError);
    // The page is still open at that point, so the snapshot is still taken.
    expect(report.replays[0]?.snapshot?.text).toBe('- still loading');
  });

  it('disposes the page after a timed-out run', async () => {
    let disposed = 0;
    await replay(
      wf([{ id: 'nav_001', intent: 'Open.', action: 'navigate', url: 'https://x.test/' }]),
      {
        pageFactory: () => loggingPage().page,
        runs: 1,
        runTimeoutMs: 20,
        runner: () => new Promise<void>(() => {}),
        dispose: () => {
          disposed++;
        },
      },
    );
    expect(disposed).toBe(1);
  });

  it('leaves a run that finishes in time alone', async () => {
    const report = await replay(
      wf([{ id: 'nav_001', intent: 'Open.', action: 'navigate', url: 'https://x.test/' }]),
      {
        pageFactory: () => loggingPage().page,
        runs: 2,
        runTimeoutMs: 5_000,
        runner: interpretWorkflow,
      },
    );
    expect(report.passed).toBe(2);
  });

  it('does not report an unhandled rejection when the runner fails after the limit', async () => {
    const report = await replay(
      wf([{ id: 'nav_001', intent: 'Open.', action: 'navigate', url: 'https://x.test/' }]),
      {
        pageFactory: () => loggingPage().page,
        runs: 1,
        runTimeoutMs: 10,
        runner: () =>
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late')), 40)),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(report.replays[0]?.error?.name).toBe('RunTimeoutError');
  });

  it('treats zero or a missing limit as no limit', async () => {
    const report = await replay(
      wf([{ id: 'nav_001', intent: 'Open.', action: 'navigate', url: 'https://x.test/' }]),
      {
        pageFactory: () => loggingPage().page,
        runs: 1,
        runTimeoutMs: 0,
        runner: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
      },
    );
    expect(report.passed).toBe(1);
  });
});

describe('interpreter: extract outputs', () => {
  const extract = (
    id: string,
    css: string,
    schema: unknown,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    intent: 'Read.',
    action: 'extract',
    target: { candidates: [{ kind: 'css', value: css }] },
    schema,
    ...extra,
  });

  const rowsSchema = {
    type: 'array',
    items: {
      type: 'object',
      properties: { sku: { type: 'string' }, qty: { type: 'integer' }, ok: { type: 'boolean' } },
    },
  };

  const tableScript = {
    count: { 'locator("table").locator("tbody tr, tr:not(:first-child)")': 2 },
    texts: {
      'locator("h1")': ['  Stock report  ', 'ignored'],
      'locator("li")': ['one', 'two'],
      'locator("table").locator("thead th, tr:first-child th")': ['sku', 'qty', 'ok'],
      'locator("table").locator("tbody tr, tr:not(:first-child)").nth(0).locator("td, th")': [
        'A-1',
        '3',
        'yes',
      ],
      'locator("table").locator("tbody tr, tr:not(:first-child)").nth(1).locator("td, th")': [
        'B-2',
        '1,250',
        'no',
      ],
    },
  };

  it('emits one output per extract, keyed by bind name or step id, with typed table rows', async () => {
    const { page } = loggingPage(tableScript);
    const ctx = createWorkflowContext({ page });
    await interpretWorkflow(
      ctx,
      wf([
        extract('extract_title', 'h1', { type: 'string' }, { bind: 'title' }),
        extract('extract_items', 'li', { type: 'array', items: { type: 'string' } }),
        extract('extract_rows', 'table', rowsSchema, { bind: 'rows' }),
      ]),
    );
    expect(ctx.drainOutputs()).toEqual([
      { title: '  Stock report  ' },
      { extract_items: ['one', 'two'] },
      {
        rows: [
          { sku: 'A-1', qty: 3, ok: true },
          { sku: 'B-2', qty: 1250, ok: false },
        ],
      },
    ]);
  });

  it('emits once per iteration for an extract inside a loop', async () => {
    const { page } = loggingPage({
      all: { 'locator("tr")': 3 },
      texts: {
        'locator("tr").all[0].locator("td")': ['first'],
        'locator("tr").all[1].locator("td")': ['second'],
        'locator("tr").all[2].locator("td")': ['third'],
      },
    });
    const ctx = createWorkflowContext({ page });
    await interpretWorkflow(
      ctx,
      wf([
        {
          id: 'loop_001',
          intent: 'Each row.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [extract('extract_cell', 'td', { type: 'string' }, { bind: 'cell' })],
        },
      ]),
    );
    // Each iteration reads its own row.
    expect(ctx.drainOutputs()).toEqual([{ cell: 'first' }, { cell: 'second' }, { cell: 'third' }]);
  });

  it('emits nothing for a step whose postcondition fails', async () => {
    const { page } = loggingPage({ visible: { 'locator("#done")': false } });
    const ctx = createWorkflowContext({ page });
    await expect(
      interpretWorkflow(
        ctx,
        wf([
          extract('extract_ok', 'h1', { type: 'string' }),
          extract(
            'extract_bad',
            'h2',
            { type: 'string' },
            { post: [{ selectorVisible: '#done' }] },
          ),
        ]),
      ),
    ).rejects.toBeInstanceOf(StepFailure);
    expect(ctx.drainOutputs()).toEqual([{ extract_ok: 'text' }]);
  });

  it('refuses an extract schema that cannot be read from a page', async () => {
    const { page, log } = loggingPage();
    const thrown = await interpretWorkflow(
      createWorkflowContext({ page }),
      wf([
        extract('extract_bad', 'div', { type: 'object', properties: { a: { type: 'string' } } }),
      ]),
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(StepFailure);
    expect((thrown as StepFailure).cause).toBeInstanceOf(InterpreterError);
    expect((thrown as StepFailure).message).toContain('schema type "object"');
    expect(log).toEqual([]);
  });

  it('makes the verifier stability check mean something: drifting extracts are caught', async () => {
    let run = 0;
    const report = await replay(
      wf([extract('extract_price', '.price', { type: 'string' }, { bind: 'price' })]),
      {
        pageFactory: () =>
          loggingPage({ texts: { 'locator(".price")': [run++ === 0 ? '£10' : '£12'] } }).page,
        runner: interpretWorkflow,
        runs: 2,
      },
    );
    expect(report.passed).toBe(2);
    expect(report.stability).toEqual({
      stable: false,
      drift: [{ path: '0.price', values: ['£10', '£12'] }],
    });
    expect(report.replays[0]?.outputs).toEqual([{ price: '£10' }]);
  });

  it('redacts a secret that shows up in extracted output', async () => {
    const report = await replay(
      wf(
        [
          {
            id: 'fill_001',
            intent: 'Token.',
            action: 'fill',
            target: { candidates: [{ kind: 'label', value: 'Token' }] },
            value: { secret: 'api_token' },
          },
          extract('extract_echo', '.echo', { type: 'string' }, { bind: 'echo' }),
        ],
        { secrets: ['api_token'] },
      ),
      {
        pageFactory: () =>
          loggingPage({ texts: { 'locator(".echo")': ['You entered tok_live_12345'] } }).page,
        runner: interpretWorkflow,
        runs: 1,
        vaultResolver: { resolve: () => 'tok_live_12345' },
      },
    );
    expect(report.replays[0]?.outputs).toEqual([{ echo: 'You entered [REDACTED:api_token]' }]);
  });
});
