// Generated code wraps every IR step in the runtime's `step()` helper so a
// failure anywhere in the step is traced back to its id and selector. The
// last block executes real generated code against the real runtime to prove
// the two halves agree.

import { describe, it, expect, beforeEach } from 'vitest';
import ts from 'typescript';
import { compile } from '../src/index.js';
import type { Workflow } from '@sfysh/ir';
// The compiler package does not depend on the runtime, and should not. The
// end-to-end check below needs the real helpers, so the test reaches across
// the workspace by path.
import * as runtime from '../../runtime/src/index.js';

function workflowOf(steps: unknown[], extra: Record<string, unknown> = {}): Workflow {
  return {
    irVersion: '1.0.0',
    id: 'wf_attribution',
    name: 'Attribution',
    steps,
    ...extra,
  } as unknown as Workflow;
}

const click = (id: string, candidates: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  intent: 'Click it.',
  action: 'click',
  target: { candidates },
  ...extra,
});

describe('codegen: step() wrapper', () => {
  it('imports step from the runtime', async () => {
    const { source } = await compile(
      workflowOf([{ id: 'nav_001', intent: 'Open.', action: 'navigate', url: 'https://x.test' }]),
    );
    expect(source).toContain("import { workflow, step, assert, poll } from '@sfysh/runtime';");
  });

  it('wraps a step with no target and passes id and action only', async () => {
    const { source } = await compile(
      workflowOf([{ id: 'nav_001', intent: 'Open.', action: 'navigate', url: 'https://x.test' }]),
    );
    expect(source).toContain(
      [
        '  // [nav_001] Open.',
        "  await step(ctx, { id: 'nav_001', action: 'navigate' }, async () => {",
        "    await page.goto('https://x.test');",
        '  });',
      ].join('\n'),
    );
  });

  it('passes the first selector candidate, which is the one the code uses', async () => {
    const { source } = await compile(
      workflowOf([
        click('click_001', [
          { kind: 'testid', value: 'submit' },
          { kind: 'css', value: '#submit' },
        ]),
      ]),
    );
    expect(source).toMatch(
      /step\(\s*ctx,\s*\{\s*id: 'click_001',\s*action: 'click',\s*selector: \{ kind: 'testid', value: 'submit' \},?\s*\}/,
    );
    expect(source).toContain("await page.getByTestId('submit').click();");
    expect(source).not.toContain('#submit');
  });

  it('runs pre and post condition checks inside the wrapper', async () => {
    const { source } = await compile(
      workflowOf([
        click('click_001', [{ kind: 'css', value: '#go' }], {
          pre: [{ selectorVisible: '#go' }],
          post: [{ urlMatches: '/done' }],
        }),
      ]),
    );
    const open = source.indexOf('await step(');
    const pre = source.indexOf("assertCondition(ctx, 'click_001', 'pre'");
    const action = source.indexOf("page.locator('#go').click()");
    const post = source.indexOf("assertCondition(ctx, 'click_001', 'post'");
    const close = source.lastIndexOf('});');
    expect(open).toBeGreaterThan(-1);
    expect(pre).toBeGreaterThan(open);
    expect(action).toBeGreaterThan(pre);
    expect(post).toBeGreaterThan(action);
    expect(close).toBeGreaterThan(post);
  });

  it('declares a bound extract outside the wrapper so later steps can read it', async () => {
    const { source } = await compile(
      workflowOf([
        {
          id: 'extract_001',
          intent: 'Read the title.',
          action: 'extract',
          target: { candidates: [{ kind: 'css', value: 'h1' }] },
          schema: { type: 'string' },
          bind: 'title',
          post: [{ selectorVisible: 'h1' }],
        },
      ]),
    );
    expect(source).toMatch(/const title = await step\(/);
    expect(source).toContain("const title = await emit.value(page.locator('h1'));");
    expect(source).toContain('return title;');
    // The post check runs after the extraction and before the value is returned.
    expect(source.indexOf("'post'")).toBeGreaterThan(source.indexOf('emit.value'));
    expect(source.indexOf('return title;')).toBeGreaterThan(source.indexOf("'post'"));
  });

  it('nests wrappers for steps inside guard and loop bodies', async () => {
    const { source } = await compile(
      workflowOf([
        {
          id: 'loop_001',
          intent: 'Each row.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [
            {
              id: 'guard_002',
              intent: 'If present.',
              action: 'guard',
              if: { selectorVisible: '.open' },
              then: [click('click_003', [{ kind: 'css', value: '.open' }])],
            },
          ],
        },
      ]),
    );
    const loop = source.indexOf("id: 'loop_001'");
    const guard = source.indexOf("id: 'guard_002'");
    const inner = source.indexOf("id: 'click_003'");
    expect(loop).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(loop);
    expect(inner).toBeGreaterThan(guard);
    // The loop reports the selector it iterates over.
    expect(source).toMatch(
      /id: 'loop_001',\s*action: 'loop',\s*selector: \{ kind: 'css', value: 'tr' \}/,
    );
  });

  it('wraps a wait step that has neither a condition nor a duration', async () => {
    const { source } = await compile(
      workflowOf([{ id: 'wait_001', intent: 'Pause.', action: 'wait' }]),
    );
    expect(source).toMatch(
      /await step\(ctx, \{ id: 'wait_001', action: 'wait' \}, async \(\) => \{\}\);/,
    );
  });
});

/**
 * Load generated source into the real runtime. The import line is replaced
 * with the runtime helpers passed as arguments, the TypeScript is transpiled
 * to JavaScript, and the module body is evaluated, which registers the
 * workflow exactly as a real import of the generated file would.
 */
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

describe('codegen end to end: generated code reports the failing step', () => {
  const locator = (overrides: Partial<runtime.Locator> = {}): runtime.Locator => {
    const base: runtime.Locator = {
      click: async () => {},
      fill: async () => {},
      isVisible: async () => true,
      locator: () => locator(),
      count: async () => 1,
      nth: () => locator(),
      allTextContents: async () => ['Dashboard'],
      all: async () => [],
    };
    return { ...base, ...overrides };
  };

  const page = (overrides: Partial<runtime.Page> = {}): runtime.Page => ({
    goto: async () => {},
    url: () => 'https://x.test/login',
    locator: () => locator(),
    getByRole: () => locator(),
    getByTestId: () => locator(),
    getByText: () => locator(),
    getByLabel: () => locator(),
    waitForTimeout: async () => {},
    snapshot: async () => '- button "Log in"',
    ...overrides,
  });

  const login = workflowOf(
    [
      {
        id: 'nav_001',
        intent: 'Open the login page.',
        action: 'navigate',
        url: 'https://x.test/login',
      },
      {
        id: 'fill_002',
        intent: 'Enter the password.',
        action: 'fill',
        target: { candidates: [{ kind: 'label', value: 'Password' }] },
        value: { secret: 'portal_pass' },
      },
      click('click_003', [{ kind: 'role', value: "button[name='Sign in']" }], {
        post: [{ urlMatches: '/dashboard' }],
      }),
      {
        id: 'extract_004',
        intent: 'Read the heading.',
        action: 'extract',
        target: { candidates: [{ kind: 'css', value: 'h1' }] },
        schema: { type: 'string' },
        bind: 'heading',
      },
    ],
    { id: 'wf_login', secrets: ['portal_pass'] },
  );

  const ctxFor = (p: runtime.Page) =>
    runtime.createWorkflowContext({ page: p, vaultResolver: { resolve: () => 'hunter2-secret' } });

  beforeEach(async () => {
    runtime.resetWorkflows();
    loadGenerated((await compile(login)).source);
  });

  it('runs clean when every step succeeds', async () => {
    const result = await runtime.run(
      'wf_login',
      ctxFor(page({ url: () => 'https://x.test/dashboard' })),
    );
    expect(result).toEqual({ workflowId: 'wf_login', status: 'ok', durationMs: result.durationMs });
  });

  it('reports the step, action and selector when an action throws', async () => {
    const failing = page({
      getByRole: () =>
        locator({
          click: async () => {
            const err = new Error('locator.click: Timeout 30000ms exceeded.');
            err.name = 'TimeoutError';
            throw err;
          },
        }),
    });
    const result = await runtime.run('wf_login', ctxFor(failing));

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({
      name: 'TimeoutError',
      stepId: 'click_003',
      action: 'click',
      selector: { kind: 'role', value: "button[name='Sign in']" },
    });
    expect(result.error?.phase).toBeUndefined();
    expect(result.snapshot?.text).toBe('- button "Log in"');
  });

  it('reports the violated condition when a postcondition fails', async () => {
    // Every action succeeds, but the page never leaves /login.
    const result = await runtime.run('wf_login', ctxFor(page()));

    expect(result.error).toMatchObject({
      name: 'PostconditionViolation',
      stepId: 'click_003',
      action: 'click',
      selector: { kind: 'role', value: "button[name='Sign in']" },
      phase: 'post',
      condition: { urlMatches: '/dashboard' },
      reason: "URL 'https://x.test/login' did not match '/dashboard'",
    });
  });

  it('attributes a fill failure to the fill step and keeps the secret out of the report', async () => {
    const failing = page({
      getByLabel: () =>
        locator({
          fill: async (value: string) => {
            throw new Error(`locator.fill: Timeout.\n  - fill("${value}")`);
          },
        }),
      snapshot: async () => '- textbox "Password": hunter2-secret',
    });
    const result = await runtime.run('wf_login', ctxFor(failing));

    expect(result.error?.stepId).toBe('fill_002');
    expect(result.error?.selector).toEqual({ kind: 'label', value: 'Password' });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('hunter2-secret');
    expect(result.snapshot?.text).toBe('- textbox "Password": [REDACTED:portal_pass]');
  });
});
