// Parity between the two executors. The same IR is run once as compiled
// code and once through the interpreter, each against a fresh page built
// from the same script. The ordered log of Page calls must be identical,
// and so must the failure report when the run fails.
//
// If this test breaks, one executor changed how it drives the page and the
// other did not. Fix the drift; do not loosen the comparison.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import type { Workflow } from '@sfysh/ir';
import * as runtime from '@sfysh/runtime';
// The verifier does not depend on the compiler, and should not. This test
// is the one place both are needed, so it reaches across the workspace.
import { compile } from '../../compiler/src/index.js';
import { interpretWorkflow } from '../src/index.js';
import { loggingPage, type PageScript } from './helpers/logging-page.js';

const here = dirname(fileURLToPath(import.meta.url));

const supplierPortal = JSON.parse(
  readFileSync(
    join(here, '..', '..', 'ir', 'src', 'schema', 'examples', 'supplier-portal.workflow.json'),
    'utf-8',
  ),
) as Workflow;

/** Register generated source with the real runtime, as importing the file would. */
function loadGenerated(source: string): void {
  // The names come from the file's own import line, so this loader keeps up
  // with whatever runtime helpers the compiler starts to use.
  const importLine = /^import \{([^}]*)\} from '@sfysh\/runtime';$/m.exec(source);
  expect(importLine).not.toBeNull();
  const names = importLine![1]!
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0) as (keyof typeof runtime)[];
  const withoutImport = source.replace(importLine![0], '');
  expect(withoutImport).not.toContain('import ');
  const js = ts.transpileModule(withoutImport, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const load = new Function(...names, js) as (...args: unknown[]) => void;
  load(...names.map((n) => runtime[n]));
}

interface Observed {
  log: string[];
  status: string;
  error: unknown;
  snapshot: unknown;
  outputs: unknown[];
}

const SECRET = 'hunter2-secret';

async function observe(id: string, script: PageScript): Promise<Observed> {
  const { page, log } = loggingPage(script);
  const ctx = runtime.createWorkflowContext({ page, vaultResolver: { resolve: () => SECRET } });
  const result = await runtime.run(id, ctx);
  return {
    log,
    status: result.status,
    // Round-trip through JSON: compares exactly what a report would contain.
    error: result.error ? JSON.parse(JSON.stringify(result.error)) : undefined,
    snapshot: result.snapshot,
    outputs: ctx.drainOutputs(),
  };
}

/** Run a workflow through both executors and return what each did. */
async function both(
  workflow: Workflow,
  script: PageScript,
): Promise<{ compiled: Observed; interpreted: Observed }> {
  runtime.resetWorkflows();
  loadGenerated((await compile(workflow)).source);
  // Give the interpreter the same entry point, so both go through run().
  runtime.workflow('interpreted', (ctx) => interpretWorkflow(ctx, workflow));
  return {
    compiled: await observe(workflow.id, script),
    interpreted: await observe('interpreted', script),
  };
}

// A workflow that uses every action, every selector kind, both loop forms,
// both guard branches, and pre and post conditions.
const everything = {
  irVersion: '1.0.0',
  id: 'wf_everything',
  name: 'Every construct',
  secrets: ['portal_pass'],
  steps: [
    {
      id: 'nav_001',
      intent: 'Open the login page.',
      action: 'navigate',
      url: 'https://x.test/login',
      waitUntil: 'domcontentloaded',
      post: [{ selectorVisible: 'form' }],
    },
    {
      id: 'fill_002',
      intent: 'Enter the email.',
      action: 'fill',
      target: { candidates: [{ kind: 'label', value: 'Email' }] },
      value: 'user@x.test',
    },
    {
      id: 'fill_003',
      intent: 'Enter the password.',
      action: 'fill',
      target: {
        candidates: [
          { kind: 'role', value: "textbox[name='Password']" },
          { kind: 'css', value: 'input[type=password]' },
        ],
      },
      value: { secret: 'portal_pass' },
    },
    {
      id: 'click_004',
      intent: 'Sign in.',
      action: 'click',
      target: { candidates: [{ kind: 'role', value: "button[name='Sign in']" }] },
      pre: [{ selectorVisible: 'button' }],
      post: [
        { urlMatches: '/dashboard' },
        { selectorAbsent: '.spinner' },
        { textPresent: 'Welcome' },
      ],
    },
    {
      id: 'guard_005',
      intent: 'Accept cookies if asked, otherwise continue.',
      action: 'guard',
      if: { selectorVisible: '#cookie-banner' },
      then: [
        {
          id: 'click_006',
          intent: 'Accept.',
          action: 'click',
          target: { candidates: [{ kind: 'text', value: 'Accept' }] },
        },
      ],
      else: [
        {
          id: 'click_007',
          intent: 'Continue.',
          action: 'click',
          target: { candidates: [{ kind: 'testid', value: 'continue' }] },
        },
      ],
    },
    {
      id: 'wait_008',
      intent: 'Wait for the report.',
      action: 'wait',
      forCondition: { selectorVisible: 'table.report' },
    },
    { id: 'wait_009', intent: 'Let it settle.', action: 'wait', millis: 200 },
    {
      id: 'assert_010',
      intent: 'We are on the dashboard.',
      action: 'assert',
      condition: { urlMatches: '/dashboard' },
    },
    {
      id: 'loop_011',
      intent: 'Load every page of results.',
      action: 'loop',
      while: { selectorVisible: '.load-more' },
      maxIterations: 10,
      do: [
        {
          id: 'click_012',
          intent: 'Load more.',
          action: 'click',
          target: { candidates: [{ kind: 'css', value: '.load-more' }] },
        },
      ],
    },
    {
      id: 'loop_013',
      intent: 'Visit each row.',
      action: 'loop',
      foreach: { candidates: [{ kind: 'css', value: 'table.report tr' }] },
      do: [
        {
          id: 'extract_014',
          intent: 'Read the row label.',
          action: 'extract',
          target: { candidates: [{ kind: 'css', value: 'td.label' }] },
          schema: { type: 'string' },
          bind: 'label',
        },
        {
          id: 'guard_015',
          intent: 'Open the row if it can be opened.',
          action: 'guard',
          if: { selectorVisible: '.row-open' },
          then: [
            {
              id: 'click_016',
              intent: 'Open the row.',
              action: 'click',
              target: { candidates: [{ kind: 'css', value: '.row-open' }] },
            },
          ],
        },
      ],
    },
    {
      id: 'extract_017',
      intent: 'Read all headings.',
      action: 'extract',
      target: { candidates: [{ kind: 'role', value: 'heading' }] },
      schema: { type: 'array', items: { type: 'string' } },
    },
    {
      id: 'extract_018',
      intent: 'Read the stock table.',
      action: 'extract',
      target: { candidates: [{ kind: 'css', value: 'table.stock' }] },
      schema: { sku: 'string', qty: 'number' },
      bind: 'rows',
    },
  ],
} as unknown as Workflow;

const healthy: PageScript = {
  url: 'https://x.test/dashboard',
  visible: {
    'locator("#cookie-banner")': false,
    'locator(".load-more")': [true, true, false],
  },
  count: {
    'locator(".spinner")': 0,
    'locator("table.stock").locator("tbody tr, tr:not(:first-child)")': 2,
  },
  all: { 'locator("table.report tr")': 3 },
  texts: {
    'locator("table.stock").locator("thead th, tr:first-child th")': ['sku', 'qty'],
    'locator("table.stock").locator("tbody tr, tr:not(:first-child)").nth(0).locator("td, th")': [
      'A1',
      '3',
    ],
    'locator("table.stock").locator("tbody tr, tr:not(:first-child)").nth(1).locator("td, th")': [
      'B2',
      '14',
    ],
  },
  snapshot: '- heading "Dashboard"',
};

describe('parity: compiled code and the interpreter drive the page identically', () => {
  beforeEach(() => {
    runtime.resetWorkflows();
  });

  it('on a workflow using every construct, when everything succeeds', async () => {
    const { compiled, interpreted } = await both(everything, healthy);

    expect(compiled.status).toBe('ok');
    expect(interpreted.status).toBe('ok');
    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);

    // Guard against a vacuous pass: the run really did exercise the page.
    expect(compiled.log.length).toBeGreaterThan(30);
    expect(compiled.log).toContain('goto("https://x.test/login",{"waitUntil":"domcontentloaded"})');
    expect(compiled.log).toContain(`getByRole("textbox",{"name":"Password"}).fill("${SECRET}")`);
    expect(compiled.log).toContain('getByTestId("continue").click');
    expect(compiled.log).not.toContain('getByText("Accept").click');
    expect(compiled.log.filter((l) => l === 'locator(".load-more").click')).toHaveLength(2);
    // A foreach body is scoped to its item: each row's own button, not the page's.
    expect(compiled.log).not.toContain('locator(".row-open").click');
    expect(
      compiled.log.filter((l) =>
        /^locator\("table\.report tr"\)\.all\[\d\]\.locator\("\.row-open"\)\.click$/.test(l),
      ),
    ).toHaveLength(3);
    expect(compiled.log).toContain(
      'locator("table.report tr").all[0].locator("td.label").allTextContents',
    );
    expect(compiled.log).toContain('waitForTimeout(200)');
  });

  it('when the other guard branch is taken', async () => {
    const script: PageScript = {
      ...healthy,
      visible: { ...healthy.visible, 'locator("#cookie-banner")': true },
    };
    const { compiled, interpreted } = await both(everything, script);
    expect(compiled.status).toBe('ok');
    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);
    expect(compiled.log).toContain('getByText("Accept").click');
  });

  it('when an action throws part-way through', async () => {
    const script: PageScript = {
      ...healthy,
      failAction: { 'getByTestId("continue")': 'locator.click: Timeout 30000ms exceeded.' },
    };
    const { compiled, interpreted } = await both(everything, script);

    expect(compiled.status).toBe('failed');
    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);
    expect(interpreted.error).toEqual(compiled.error);
    expect(interpreted.snapshot).toEqual(compiled.snapshot);
    expect(compiled.error).toMatchObject({
      stepId: 'click_007',
      action: 'click',
      selector: { kind: 'testid', value: 'continue' },
    });
    // Nothing ran after the failing step, apart from the snapshot.
    expect(compiled.log.at(-2)).toBe('getByTestId("continue").click');
    expect(compiled.log.at(-1)).toBe('snapshot');
  });

  it('when a postcondition is violated', async () => {
    const script: PageScript = {
      ...healthy,
      count: { ...healthy.count, 'locator(".spinner")': 1 },
    };
    const { compiled, interpreted } = await both(everything, script);

    expect(compiled.status).toBe('failed');
    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.error).toMatchObject({
      stepId: 'click_004',
      phase: 'post',
      condition: { selectorAbsent: '.spinner' },
    });
  });

  it('when a precondition is violated', async () => {
    const script: PageScript = {
      ...healthy,
      visible: { ...healthy.visible, 'locator("button")': false },
    };
    const { compiled, interpreted } = await both(everything, script);
    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.error).toMatchObject({ stepId: 'click_004', phase: 'pre' });
  });

  it('when an assert step fails', async () => {
    // The login post check passes on the first url() call; the assert step
    // makes the second.
    let calls = 0;
    const scriptFor = (): PageScript => ({ ...healthy });
    const run = async (id: string) => {
      calls = 0;
      const { page, log } = loggingPage(scriptFor());
      const flaky = {
        ...page,
        url: () => {
          log.push('url');
          return ++calls === 1 ? 'https://x.test/dashboard' : 'https://x.test/logged-out';
        },
      };
      const ctx = runtime.createWorkflowContext({
        page: flaky,
        vaultResolver: { resolve: () => SECRET },
      });
      const result = await runtime.run(id, ctx);
      return {
        log,
        error: JSON.parse(JSON.stringify(result.error ?? null)) as unknown,
        outputs: ctx.drainOutputs(),
      };
    };

    runtime.resetWorkflows();
    loadGenerated((await compile(everything)).source);
    runtime.workflow('interpreted', (ctx) => interpretWorkflow(ctx, everything));
    const compiled = await run('wf_everything');
    const interpreted = await run('interpreted');

    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.error).toMatchObject({ name: 'AssertionError', stepId: 'assert_010' });
  });

  it('when a while loop runs past maxIterations', async () => {
    const runaway = {
      irVersion: '1.0.0',
      id: 'wf_runaway',
      name: 'Runaway loop',
      steps: [
        {
          id: 'loop_001',
          intent: 'Load more until it stops.',
          action: 'loop',
          while: { selectorVisible: '.more' },
          maxIterations: 3,
          do: [
            {
              id: 'click_002',
              intent: 'Load more.',
              action: 'click',
              target: { candidates: [{ kind: 'css', value: '.more' }] },
            },
          ],
        },
      ],
    } as unknown as Workflow;
    const { compiled, interpreted } = await both(runaway, {});

    expect(compiled.status).toBe('failed');
    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.error).toMatchObject({ name: 'LoopLimitError', stepId: 'loop_001' });
    expect(compiled.log.filter((l) => l === 'locator(".more").click')).toHaveLength(3);
  });

  it('when a foreach finds more items than maxIterations', async () => {
    const tooMany = {
      irVersion: '1.0.0',
      id: 'wf_too_many',
      name: 'Too many rows',
      steps: [
        {
          id: 'loop_001',
          intent: 'Each row.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          maxIterations: 2,
          do: [
            {
              id: 'click_002',
              intent: 'Open.',
              action: 'click',
              target: { candidates: [{ kind: 'role', value: "button[name='Open']" }] },
            },
          ],
        },
      ],
    } as unknown as Workflow;
    const { compiled, interpreted } = await both(tooMany, { all: { 'locator("tr")': 5 } });

    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.error).toMatchObject({ name: 'LoopLimitError', stepId: 'loop_001' });
    // Role lookups are scoped to the row too.
    expect(compiled.log).toContain(
      'locator("tr").all[1].getByRole("button",{"name":"Open"}).click',
    );
  });

  it('when a step runs past its timeoutMs', async () => {
    const slow = {
      irVersion: '1.0.0',
      id: 'wf_slow',
      name: 'Slow step',
      steps: [
        {
          id: 'nav_001',
          intent: 'Open.',
          action: 'navigate',
          url: 'https://x.test/',
          timeoutMs: 20,
        },
      ],
    } as unknown as Workflow;
    runtime.resetWorkflows();
    loadGenerated((await compile(slow)).source);
    runtime.workflow('interpreted', (ctx) => interpretWorkflow(ctx, slow));
    const runOn = async (id: string) => {
      const { page } = loggingPage({});
      const hanging = { ...page, goto: () => new Promise<void>(() => {}) };
      const ctx = runtime.createWorkflowContext({ page: hanging });
      const result = await runtime.run(id, ctx);
      return JSON.parse(JSON.stringify(result.error ?? null)) as unknown;
    };
    const compiled = await runOn('wf_slow');
    const interpreted = await runOn('interpreted');

    expect(interpreted).toEqual(compiled);
    expect(compiled).toMatchObject({ name: 'StepTimeoutError', stepId: 'nav_001' });
  });

  it('reads urlMatches in a flow condition as a substring when it is not a valid regex', async () => {
    const odd = {
      irVersion: '1.0.0',
      id: 'wf_odd_url',
      name: 'Odd URL pattern',
      steps: [
        {
          id: 'assert_001',
          intent: 'On the second page.',
          action: 'assert',
          condition: { urlMatches: '?page=(2' },
        },
      ],
    } as unknown as Workflow;
    const { compiled, interpreted } = await both(odd, { url: 'https://x.test/list?page=(2' });

    // Before, compiled code built `new RegExp('?page=(2')` and threw.
    expect(compiled.status).toBe('ok');
    expect(interpreted.status).toBe('ok');
    expect(interpreted.log).toEqual(compiled.log);
  });

  it('on a table whose headers differ in case and use an x-header alias', async () => {
    const aliased = {
      irVersion: '1.0.0',
      id: 'wf_aliased_table',
      name: 'Aliased table',
      steps: [
        {
          id: 'extract_001',
          intent: 'Read the stock table.',
          action: 'extract',
          target: { candidates: [{ kind: 'css', value: 'table.stock' }] },
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string', 'x-header': 'Stock code' },
                qty: { type: 'integer' },
              },
            },
          },
          bind: 'rows',
        },
      ],
    } as unknown as Workflow;
    const { compiled, interpreted } = await both(aliased, {
      url: 'https://x.test/stock',
      count: { 'locator("table.stock").locator("tbody tr, tr:not(:first-child)")': 1 },
      texts: {
        'locator("table.stock").locator("thead th, tr:first-child th")': ['STOCK CODE', ' Qty '],
        'locator("table.stock").locator("tbody tr, tr:not(:first-child)").nth(0).locator("td, th")':
          ['A1', '7'],
      },
    });

    expect(compiled.status).toBe('ok');
    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);
    expect(compiled.outputs).toEqual([{ rows: [{ sku: 'A1', qty: 7 }] }]);
  });

  it('on the reference supplier-portal workflow', async () => {
    const script: PageScript = {
      url: 'https://portal.acmesupply.com/dashboard/reports/stock',
      visible: { "locator(\"[role='dialog'] button:has-text('Accept')\")": true },
      count: { 'getByRole("table").locator("tbody tr, tr:not(:first-child)")': 2 },
      texts: {
        'getByRole("table").locator("thead th, tr:first-child th")': [
          'sku',
          'name',
          'qty',
          'reorderLevel',
        ],
        'getByRole("table").locator("tbody tr, tr:not(:first-child)").nth(0).locator("td, th")': [
          'A-1',
          'Widget',
          '3',
          '10',
        ],
        'getByRole("table").locator("tbody tr, tr:not(:first-child)").nth(1).locator("td, th")': [
          'B-2',
          'Gadget',
          '1,250',
          '40',
        ],
      },
      snapshot: '- table',
    };
    const { compiled, interpreted } = await both(supplierPortal, script);

    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.outputs).toEqual(compiled.outputs);
    expect(interpreted.status).toBe(compiled.status);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.log.length).toBeGreaterThan(10);

    expect(compiled.status).toBe('ok');
    expect(compiled.log).toContain(`getByRole("textbox",{"name":"Password"}).fill("${SECRET}")`);
    expect(compiled.log).toContain('getByRole("button",{"name":"Accept"}).click');

    // The reference workflow declares typed rows. Both executors read the
    // table row by row and produce the same typed output.
    expect(compiled.outputs).toEqual([
      {
        allRows: [
          { sku: 'A-1', name: 'Widget', qty: 3, reorderLevel: 10 },
          { sku: 'B-2', name: 'Gadget', qty: 1250, reorderLevel: 40 },
        ],
      },
    ]);
  });
});
