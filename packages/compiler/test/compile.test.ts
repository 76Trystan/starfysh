import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compile, compileUnknown, CompilerError, formatTypeScript } from '../src/index.js';
import type { Workflow } from '@sfysh/ir';

const __dirname = dirname(fileURLToPath(import.meta.url));

const supplierPortal = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', 'ir', 'src', 'schema', 'examples', 'supplier-portal.workflow.json'),
    'utf-8',
  ),
) as Workflow;

describe('compile: end-to-end with reference workflow', () => {
  it('produces non-empty TypeScript source', async () => {
    const result = await compile(supplierPortal);
    expect(result.source.length).toBeGreaterThan(0);
    expect(result.workflowId).toBe('wf_acme_stock');
  });

  it('imports workflow, assert, and poll from @sfysh/runtime', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain("from '@sfysh/runtime'");
    expect(source).toContain('workflow');
    expect(source).toContain('assert');
    expect(source).toContain('poll');
  });

  it('includes @sfysh/runtime imports when secrets or extraction are used', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain("from '@sfysh/runtime'");
    expect(source).toContain('vault');
    expect(source).toContain('emit');
  });

  it('wraps the body in a workflow() call with the workflow id', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain("workflow('wf_acme_stock'");
    expect(source).toContain('async (ctx)');
    // ADR 0010: generated code pulls page, vault, emit off the per-run ctx.
    expect(source).toContain('const { page, vault, emit } = ctx;');
  });

  it('emits a provenance comment for each step', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain('// [step_01_goto_login]');
    expect(source).toContain('// [step_04_submit_login]');
    expect(source).toContain('// [step_07_extract_rows]');
  });

  it('resolves secret references via vault()', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain("vault('supplier_portal_user')");
    expect(source).toContain("vault('supplier_portal_pass')");
    expect(source).not.toContain('supplier_portal_pass"');
  });

  it('never inlines a secret literal value', async () => {
    const { source } = await compile(supplierPortal);
    const forbidden = ['hunter2', 'password123', 'my-actual-password'];
    for (const literal of forbidden) {
      expect(source).not.toContain(literal);
    }
  });
});

describe('compile: determinism', () => {
  it('produces byte-identical output on repeat compiles of the same workflow', async () => {
    const runs = await Promise.all([
      compile(supplierPortal),
      compile(supplierPortal),
      compile(supplierPortal),
    ]);
    expect(runs[1]!.source).toBe(runs[0]!.source);
    expect(runs[2]!.source).toBe(runs[0]!.source);
  });

  it('produces byte-identical output across 20 sequential compiles', async () => {
    const baseline = (await compile(supplierPortal)).source;
    for (let i = 0; i < 20; i++) {
      const run = await compile(supplierPortal);
      expect(run.source).toBe(baseline);
    }
  });
});

describe('compile: validation', () => {
  it('rejects a workflow missing irVersion before any codegen', async () => {
    const { irVersion: _ignored, ...rest } = supplierPortal as Workflow & {
      irVersion: string;
    };
    await expect(compileUnknown(rest)).rejects.toThrow(CompilerError);
  });

  it('rejects a workflow with no steps', async () => {
    await expect(compileUnknown({ ...supplierPortal, steps: [] })).rejects.toThrow(CompilerError);
  });

  it('error message includes the first few validation errors', async () => {
    try {
      await compileUnknown({ irVersion: '1.0.0' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CompilerError);
      expect((err as CompilerError).message).toContain('failed validation');
    }
  });
});

describe('compile: selector rendering', () => {
  it('renders a role selector with a name attribute as getByRole with options', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_role',
      name: 'Role selector test',
      steps: [
        {
          id: 'click_submit',
          intent: 'Click submit.',
          action: 'click',
          target: {
            candidates: [{ kind: 'role', value: "button[name='Submit']" }],
          },
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain("page.getByRole('button', { name: 'Submit' })");
  });

  it('renders a testid selector as getByTestId', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_testid',
      name: 'Test id selector',
      steps: [
        {
          id: 'click_cta',
          intent: 'Click the CTA.',
          action: 'click',
          target: { candidates: [{ kind: 'testid', value: 'main-cta' }] },
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain("page.getByTestId('main-cta')");
  });
});

describe('compile: guard step rendering', () => {
  function guardWorkflow(guard: Workflow['steps'][number]): Workflow {
    return { irVersion: '1.0.0', id: 'test_guard', name: 'Guard test', steps: [guard] };
  }

  it('renders a guard with if/then as an if block containing the nested step', async () => {
    const { source } = await compile(
      guardWorkflow({
        id: 'grd_cookie',
        intent: 'Dismiss cookie banner if present.',
        action: 'guard',
        if: { selectorVisible: '.cookie-banner' },
        then: [
          {
            id: 'clk_accept',
            intent: 'Click accept.',
            action: 'click',
            target: { candidates: [{ kind: 'role', value: "button[name='Accept']" }] },
          },
        ],
      }),
    );
    expect(source).toContain('// [grd_cookie]');
    expect(source).toContain("await page.locator('.cookie-banner').isVisible()");
    expect(source).toContain('// [clk_accept]');
    expect(source).toContain("page.getByRole('button', { name: 'Accept' }).click()");
    expect(source).not.toContain('else');
  });

  it('renders a guard with then and else branches', async () => {
    const { source } = await compile(
      guardWorkflow({
        id: 'grd_modal',
        intent: 'Handle modal.',
        action: 'guard',
        if: { textPresent: 'Accept cookies' },
        then: [
          {
            id: 'clk_accept',
            intent: 'Accept.',
            action: 'click',
            target: { candidates: [{ kind: 'role', value: 'button' }] },
          },
        ],
        else: [
          {
            id: 'clk_skip',
            intent: 'Skip.',
            action: 'click',
            target: { candidates: [{ kind: 'testid', value: 'skip-btn' }] },
          },
        ],
      }),
    );
    expect(source).toContain('// [grd_modal]');
    expect(source).toContain("(await page.getByText('Accept cookies').count()) > 0");
    expect(source).toContain('} else {');
    expect(source).toContain('// [clk_accept]');
    expect(source).toContain('// [clk_skip]');
    expect(source).toContain("page.getByTestId('skip-btn')");
  });

  it('renders all steps in a multi-step then branch', async () => {
    const { source } = await compile(
      guardWorkflow({
        id: 'grd_multi',
        intent: 'Multi-step guard.',
        action: 'guard',
        if: { selectorVisible: '#overlay' },
        then: [
          {
            id: 'clk_one',
            intent: 'First click.',
            action: 'click',
            target: { candidates: [{ kind: 'role', value: 'button' }] },
          },
          {
            id: 'clk_two',
            intent: 'Second click.',
            action: 'click',
            target: { candidates: [{ kind: 'testid', value: 'confirm' }] },
          },
        ],
      }),
    );
    expect(source).toContain('// [clk_one]');
    expect(source).toContain('// [clk_two]');
  });

  it('renders a guard nested inside another guard', async () => {
    const { source } = await compile(
      guardWorkflow({
        id: 'grd_outer',
        intent: 'Outer guard.',
        action: 'guard',
        if: { selectorVisible: '.outer' },
        then: [
          {
            id: 'grd_inner',
            intent: 'Inner guard.',
            action: 'guard',
            if: { selectorVisible: '.inner' },
            then: [
              {
                id: 'clk_deep',
                intent: 'Deep click.',
                action: 'click',
                target: { candidates: [{ kind: 'role', value: 'button' }] },
              },
            ],
          },
        ],
      }),
    );
    expect(source).toContain('// [grd_outer]');
    expect(source).toContain('// [grd_inner]');
    expect(source).toContain('// [clk_deep]');
    // Both guards produce an if block -- the inner one is nested inside the outer.
    expect(source.indexOf('// [grd_inner]')).toBeGreaterThan(source.indexOf('// [grd_outer]'));
    expect(source.indexOf('// [clk_deep]')).toBeGreaterThan(source.indexOf('// [grd_inner]'));
  });
});

describe('compile: loop step rendering', () => {
  function loopWorkflow(loop: Workflow['steps'][number]): Workflow {
    return { irVersion: '1.0.0', id: 'test_loop', name: 'Loop test', steps: [loop] };
  }

  it('renders a foreach loop as a for-of over the target', async () => {
    const { source } = await compile(
      loopWorkflow({
        id: 'lp_rows',
        intent: 'Process each table row.',
        action: 'loop',
        foreach: { candidates: [{ kind: 'role', value: 'row' }] },
        do: [
          {
            id: 'clk_row',
            intent: 'Click the row.',
            action: 'click',
            target: { candidates: [{ kind: 'role', value: 'button' }] },
          },
        ],
      }),
    );
    expect(source).toContain('// [lp_rows]');
    expect(source).toContain('for (const item of');
    expect(source).toContain("page.getByRole('row').all()");
    expect(source).toContain('// [clk_row]');
    expect(source).not.toContain('while (');
  });

  it('renders a while loop with a condition', async () => {
    const { source } = await compile(
      loopWorkflow({
        id: 'lp_pages',
        intent: 'Paginate while next page is available.',
        action: 'loop',
        while: { selectorVisible: '.next-page' },
        do: [
          {
            id: 'clk_next',
            intent: 'Click next page.',
            action: 'click',
            target: { candidates: [{ kind: 'css', value: '.next-page' }] },
          },
        ],
      }),
    );
    expect(source).toContain('// [lp_pages]');
    expect(source).toContain('while (');
    expect(source).toContain("await page.locator('.next-page').isVisible()");
    expect(source).toContain('// [clk_next]');
    expect(source).not.toContain('for (const item of');
  });

  it('renders all steps in a multi-step do block', async () => {
    const { source } = await compile(
      loopWorkflow({
        id: 'lp_multi',
        intent: 'Multi-step loop.',
        action: 'loop',
        foreach: { candidates: [{ kind: 'role', value: 'listitem' }] },
        do: [
          {
            id: 'clk_item',
            intent: 'Click item.',
            action: 'click',
            target: { candidates: [{ kind: 'role', value: 'button' }] },
          },
          {
            id: 'nav_back',
            intent: 'Navigate back.',
            action: 'navigate',
            url: 'https://example.com',
          },
        ],
      }),
    );
    expect(source).toContain('// [clk_item]');
    expect(source).toContain('// [nav_back]');
    expect(source).toContain("page.goto('https://example.com')");
  });

  it('renders a guard nested inside a foreach loop', async () => {
    const { source } = await compile(
      loopWorkflow({
        id: 'lp_with_guard',
        intent: 'Loop with a conditional inside.',
        action: 'loop',
        foreach: { candidates: [{ kind: 'role', value: 'row' }] },
        do: [
          {
            id: 'grd_in_loop',
            intent: 'Conditional check inside loop.',
            action: 'guard',
            if: { selectorVisible: '.checkbox' },
            then: [
              {
                id: 'clk_check',
                intent: 'Check the box.',
                action: 'click',
                target: { candidates: [{ kind: 'css', value: '.checkbox' }] },
              },
            ],
          },
        ],
      }),
    );
    expect(source).toContain('// [lp_with_guard]');
    expect(source).toContain('for (const item of');
    expect(source).toContain('// [grd_in_loop]');
    expect(source).toContain('// [clk_check]');
    // Guard appears inside the loop body.
    expect(source.indexOf('// [grd_in_loop]')).toBeGreaterThan(
      source.indexOf('// [lp_with_guard]'),
    );
  });

  it('renders a loop nested inside a loop', async () => {
    const { source } = await compile(
      loopWorkflow({
        id: 'lp_outer',
        intent: 'Outer loop.',
        action: 'loop',
        foreach: { candidates: [{ kind: 'role', value: 'row' }] },
        do: [
          {
            id: 'lp_inner',
            intent: 'Inner loop.',
            action: 'loop',
            foreach: { candidates: [{ kind: 'role', value: 'cell' }] },
            do: [
              {
                id: 'clk_cell',
                intent: 'Click cell.',
                action: 'click',
                target: { candidates: [{ kind: 'role', value: 'button' }] },
              },
            ],
          },
        ],
      }),
    );
    expect(source).toContain('// [lp_outer]');
    expect(source).toContain('// [lp_inner]');
    expect(source).toContain('// [clk_cell]');
    expect(source.indexOf('// [lp_inner]')).toBeGreaterThan(source.indexOf('// [lp_outer]'));
  });
});

describe('compile: pre/post condition asserts (ADR 0011)', () => {
  it('emits an assertCondition call for each post condition on the reference workflow', async () => {
    const { source } = await compile(supplierPortal);
    // supplier-portal has two `post` conditions on step_06 (urlMatches and selectorVisible).
    expect(source).toMatch(
      /assertCondition\(ctx, 'step_06_open_stock_report', 'post',[\s\n]*\{[\s\n]*urlMatches: '\/reports\/stock'/,
    );
    // The selectorVisible call is long enough that Prettier wraps it; assert on
    // the stable fragments the compiler must still emit.
    expect(source).toMatch(
      /assertCondition\(ctx, 'step_06_open_stock_report', 'post',[\s\n]*\{[\s\n]*selectorVisible: 'table\.report-rows'/,
    );
  });

  it('imports assertCondition when any step has pre or post conditions', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain('assertCondition');
    expect(source).toMatch(/from '@sfysh\/runtime'/);
  });

  it('omits assertCondition from the import list when no step has pre or post', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_no_conditions',
      name: 'No conditions',
      steps: [
        {
          id: 'nav_home',
          intent: 'Open home.',
          action: 'navigate',
          url: 'https://example.com',
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).not.toContain('assertCondition');
  });

  it('emits a pre-condition assert before the step body', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_pre',
      name: 'Pre condition',
      steps: [
        {
          id: 'clk_submit',
          intent: 'Click submit.',
          action: 'click',
          pre: [{ urlMatches: '/dashboard' }],
          target: { candidates: [{ kind: 'role', value: "button[name='Submit']" }] },
        },
      ],
    };
    const { source } = await compile(workflow);
    const preIdx = source.indexOf("assertCondition(ctx, 'clk_submit', 'pre',");
    const bodyIdx = source.indexOf("page.getByRole('button', { name: 'Submit' }).click()");
    expect(preIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(preIdx);
  });

  it('emits post-condition asserts for steps nested inside a guard branch', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_nested_guard',
      name: 'Nested guard',
      steps: [
        {
          id: 'grd_cookie',
          intent: 'Dismiss banner.',
          action: 'guard',
          if: { selectorVisible: '.cookie-banner' },
          then: [
            {
              id: 'clk_accept',
              intent: 'Accept.',
              action: 'click',
              post: [{ selectorAbsent: '.cookie-banner' }],
              target: { candidates: [{ kind: 'role', value: "button[name='Accept']" }] },
            },
          ],
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain(
      "await assertCondition(ctx, 'clk_accept', 'post', { selectorAbsent: '.cookie-banner' });",
    );
    expect(source).toContain('assertCondition');
  });

  it('emits post-condition asserts for steps nested inside a loop', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_nested_loop',
      name: 'Nested loop',
      steps: [
        {
          id: 'lp_rows',
          intent: 'Iterate rows.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'role', value: 'row' }] },
          do: [
            {
              id: 'clk_row',
              intent: 'Click row.',
              action: 'click',
              post: [{ textPresent: 'Updated' }],
              target: { candidates: [{ kind: 'role', value: 'button' }] },
            },
          ],
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain(
      "await assertCondition(ctx, 'clk_row', 'post', { textPresent: 'Updated' });",
    );
  });
});

describe('compile: extract schema branching', () => {
  it('renders a string-schema extract as emit.value', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_value',
      name: 'Value extract',
      steps: [
        {
          id: 'ext_name',
          intent: 'Extract user name.',
          action: 'extract',
          target: { candidates: [{ kind: 'testid', value: 'user-name' }] },
          schema: { type: 'string' },
          bind: 'name',
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain("await emit.value(page.getByTestId('user-name'))");
    expect(source).toContain('const name =');
    expect(source).not.toContain('emit.table');
  });

  it('renders an array-schema extract as emit.list', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_list',
      name: 'List extract',
      steps: [
        {
          id: 'ext_items',
          intent: 'Extract item texts.',
          action: 'extract',
          target: { candidates: [{ kind: 'css', value: '.item' }] },
          schema: { type: 'array', items: { type: 'string' } },
          bind: 'items',
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain("await emit.list(page.locator('.item'))");
    expect(source).toContain('const items =');
    expect(source).not.toContain('emit.table');
  });

  it('renders a table-schema extract as emit.table (existing behaviour)', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_table',
      name: 'Table extract',
      steps: [
        {
          id: 'ext_rows',
          intent: 'Extract table rows.',
          action: 'extract',
          target: { candidates: [{ kind: 'role', value: 'table' }] },
          schema: { sku: 'string', qty: 'number' },
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain('emit.table');
    expect(source).not.toContain('emit.value');
    expect(source).not.toContain('emit.list');
  });

  it('stores an unbound extract in a local and emits it under the step id', async () => {
    const workflow: Workflow = {
      irVersion: '1.0.0',
      id: 'test_novar',
      name: 'No bind',
      steps: [
        {
          id: 'ext_bare',
          intent: 'Extract bare.',
          action: 'extract',
          target: { candidates: [{ kind: 'testid', value: 'x' }] },
          schema: { type: 'string' },
        },
      ],
    };
    const { source } = await compile(workflow);
    expect(source).toContain("const extracted = await emit.value(page.getByTestId('x'));");
    expect(source).toContain('emit.output({ ext_bare: extracted });');
    // Nothing is declared outside the wrapper, because nothing later reads it.
    expect(source).toMatch(/^\s*await step\(/m);
    expect(source).not.toContain('return extracted');
  });

  it('emits a bound extract under its bind name, after the post checks', async () => {
    const workflow = {
      irVersion: '1.0.0',
      id: 'test_bound',
      name: 'Bound',
      steps: [
        {
          id: 'ext_title',
          intent: 'Read the title.',
          action: 'extract',
          target: { candidates: [{ kind: 'css', value: 'h1' }] },
          schema: { type: 'string' },
          bind: 'title',
          post: [{ selectorVisible: 'h1' }],
        },
      ],
    } as unknown as Workflow;
    const { source } = await compile(workflow);
    expect(source).toContain('emit.output({ title: title });');
    expect(source.indexOf('emit.output(')).toBeGreaterThan(source.indexOf("'post'"));
    expect(source.indexOf('return title;')).toBeGreaterThan(source.indexOf('emit.output('));
  });

  it('turns an array-of-objects schema into a typed column map for emit.table', async () => {
    const workflow = {
      irVersion: '1.0.0',
      id: 'test_rows',
      name: 'Rows',
      steps: [
        {
          id: 'ext_rows',
          intent: 'Read the rows.',
          action: 'extract',
          target: { candidates: [{ kind: 'css', value: 'table' }] },
          schema: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sku: { type: 'string' },
                qty: { type: 'integer' },
                inStock: { type: 'boolean' },
              },
            },
          },
          bind: 'rows',
        },
      ],
    } as unknown as Workflow;
    const { source } = await compile(workflow);
    expect(source).toMatch(
      /emit\.table\(page\.locator\('table'\), \{\s*sku: 'string',\s*qty: 'number',\s*inStock: 'boolean',?\s*\}\)/,
    );
    expect(source).not.toContain("type: 'array'");
  });

  it('refuses an extract schema it cannot read from a page', async () => {
    const workflow = {
      irVersion: '1.0.0',
      id: 'test_bad_schema',
      name: 'Bad schema',
      steps: [
        {
          id: 'ext_bad',
          intent: 'Read something odd.',
          action: 'extract',
          target: { candidates: [{ kind: 'css', value: 'table' }] },
          schema: {
            type: 'array',
            items: { type: 'object', properties: { tags: { type: 'array' } } },
          },
        },
      ],
    } as unknown as Workflow;
    await expect(compile(workflow)).rejects.toThrow(CompilerError);
    await expect(compile(workflow)).rejects.toThrow(/ext_bad.*column 'tags'/);
  });

  it('no longer flushes outputs from generated code; the host drains or flushes them', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).not.toContain('flushOutputs');
    expect(source).toContain('emit.output({ allRows: allRows });');
  });
});

describe('formatTypeScript', () => {
  it('normalises whitespace and semicolons', async () => {
    const dirty = 'const  x=1\nconst y    = 2';
    const formatted = await formatTypeScript(dirty);
    expect(formatted).toBe('const x = 1;\nconst y = 2;\n');
  });

  it('is deterministic for the same input', async () => {
    const src = 'const x = 1;\nconst y = 2;';
    const [a, b, c] = await Promise.all([
      formatTypeScript(src),
      formatTypeScript(src),
      formatTypeScript(src),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
