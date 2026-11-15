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
  const withoutImport = source.replace(/^import \{[^}]*\} from '@sfysh\/runtime';$/m, '');
  expect(withoutImport).not.toContain('import ');
  const js = ts.transpileModule(withoutImport, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const names = ['workflow', 'step', 'assert', 'poll', 'assertCondition'] as const;
  const load = new Function(...names, js) as (...args: unknown[]) => void;
  load(...names.map((n) => runtime[n]));
}

interface Observed {
  log: string[];
  status: string;
  error: unknown;
  snapshot: unknown;
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

    // Guard against a vacuous pass: the run really did exercise the page.
    expect(compiled.log.length).toBeGreaterThan(30);
    expect(compiled.log).toContain('goto("https://x.test/login",{"waitUntil":"domcontentloaded"})');
    expect(compiled.log).toContain(`getByRole("textbox",{"name":"Password"}).fill("${SECRET}")`);
    expect(compiled.log).toContain('getByTestId("continue").click');
    expect(compiled.log).not.toContain('getByText("Accept").click');
    expect(compiled.log.filter((l) => l === 'locator(".load-more").click')).toHaveLength(2);
    expect(compiled.log.filter((l) => l === 'locator(".row-open").click')).toHaveLength(3);
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
      return { log, error: JSON.parse(JSON.stringify(result.error ?? null)) as unknown };
    };

    runtime.resetWorkflows();
    loadGenerated((await compile(everything)).source);
    runtime.workflow('interpreted', (ctx) => interpretWorkflow(ctx, everything));
    const compiled = await run('wf_everything');
    const interpreted = await run('interpreted');

    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.error).toMatchObject({ name: 'AssertionError', stepId: 'assert_010' });
  });

  it('on the reference supplier-portal workflow', async () => {
    const script: PageScript = {
      url: 'https://portal.acmesupply.com/dashboard/reports/stock',
      visible: { "locator(\"[role='dialog'] button:has-text('Accept')\")": true },
      snapshot: '- table',
    };
    const { compiled, interpreted } = await both(supplierPortal, script);

    expect(interpreted.log).toEqual(compiled.log);
    expect(interpreted.status).toBe(compiled.status);
    expect(interpreted.error).toEqual(compiled.error);
    expect(compiled.log.length).toBeGreaterThan(10);

    expect(compiled.status).toBe('ok');
    expect(compiled.log).toContain(`getByRole("textbox",{"name":"Password"}).fill("${SECRET}")`);
    expect(compiled.log).toContain('getByRole("button",{"name":"Accept"}).click');

    // Recorded so a change here is noticed: the reference workflow's last
    // step declares an array-of-objects schema, and both executors read any
    // `type: 'array'` schema as a flat text list. The table is read with one
    // allTextContents() call, not row by row.
    expect(compiled.log.at(-1)).toBe('getByRole("table").allTextContents');
  });
});
