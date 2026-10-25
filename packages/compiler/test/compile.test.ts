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
    expect(source).toContain('async (page)');
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
