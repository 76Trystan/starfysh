import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compile, compileUnknown, CompilerError, formatTypeScript } from '../src/index.js';
import type { Workflow } from '@asc/ir';

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

  it('imports workflow, assert, and poll from @asc/runtime', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain("from '@asc/runtime'");
    expect(source).toContain('workflow');
    expect(source).toContain('assert');
    expect(source).toContain('poll');
  });

  it('includes @asc/runtime imports when secrets or extraction are used', async () => {
    const { source } = await compile(supplierPortal);
    expect(source).toContain("from '@asc/runtime'");
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
