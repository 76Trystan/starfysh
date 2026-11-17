// Loop caps, step deadlines, foreach scoping, bind names and role
// attributes in generated code. The behaviour itself is checked against the
// interpreter in the verifier's parity test; these tests pin the source.

import { describe, it, expect } from 'vitest';
import { compile, CompilerError } from '../src/index.js';
import type { Workflow } from '@sfysh/ir';

function wf(steps: unknown[]): Workflow {
  return { irVersion: '1.0.0', id: 'wf_control', name: 'Control', steps } as unknown as Workflow;
}

const click = (id: string, value: string, kind = 'css') => ({
  id,
  intent: 'Click.',
  action: 'click',
  target: { candidates: [{ kind, value }] },
});

const extract = (id: string, bind?: string) => ({
  id,
  intent: 'Read.',
  action: 'extract',
  target: { candidates: [{ kind: 'css', value: 'h1' }] },
  schema: { type: 'string' },
  ...(bind !== undefined ? { bind } : {}),
});

describe('compile: loop caps', () => {
  it('passes the step maxIterations to the loop helper', async () => {
    const { source } = await compile(
      wf([
        {
          id: 'lp_1',
          intent: 'Rows.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          maxIterations: 7,
          do: [click('c_1', '.open')],
        },
        {
          id: 'lp_2',
          intent: 'More.',
          action: 'loop',
          while: { selectorVisible: '.more' },
          maxIterations: 4,
          do: [click('c_2', '.more')],
        },
      ]),
    );
    expect(source).toContain("await forEachItem('lp_1', 7, ");
    expect(source).toContain("await whileHolds(page, 'lp_2', { selectorVisible: '.more' }, 4, ");
  });

  it('uses the schema default of 100 when maxIterations is not set', async () => {
    const { source } = await compile(
      wf([
        {
          id: 'lp_1',
          intent: 'Rows.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [click('c_1', '.open')],
        },
      ]),
    );
    expect(source).toContain("await forEachItem('lp_1', 100, ");
  });
});

describe('compile: step deadlines', () => {
  it('passes timeoutMs to step()', async () => {
    const { source } = await compile(wf([{ ...click('c_1', '#go'), timeoutMs: 5000 }]));
    expect(source).toContain('{ timeoutMs: 5000 }');
  });

  it('leaves the option out when timeoutMs is absent or zero', async () => {
    const { source } = await compile(
      wf([click('c_1', '#go'), { ...click('c_2', '#next'), timeoutMs: 0 }]),
    );
    expect(source).not.toContain('timeoutMs');
  });
});

describe('compile: foreach scoping', () => {
  it('scopes every selector kind in a foreach body to the item', async () => {
    const { source } = await compile(
      wf([
        {
          id: 'lp_1',
          intent: 'Rows.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [
            click('c_role', "button[name='Open']", 'role'),
            click('c_testid', 'open', 'testid'),
            click('c_text', 'Open', 'text'),
            {
              id: 'f_label',
              intent: 'Fill.',
              action: 'fill',
              target: { candidates: [{ kind: 'label', value: 'Qty' }] },
              value: '1',
            },
            click('c_css', '.open'),
            extract('x_row', 'rowTitle'),
          ],
        },
      ]),
    );
    expect(source).toContain("await item.getByRole('button', { name: 'Open' }).click();");
    expect(source).toContain("await item.getByTestId('open').click();");
    expect(source).toContain("await item.getByText('Open').click();");
    expect(source).toContain("await item.getByLabel('Qty').fill('1');");
    expect(source).toContain("await item.locator('.open').click();");
    expect(source).toContain("await emit.value(item.locator('h1'));");
  });

  it('scopes a nested foreach to the outer item, and its body to the inner one', async () => {
    const { source } = await compile(
      wf([
        {
          id: 'lp_rows',
          intent: 'Rows.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [
            {
              id: 'lp_cells',
              intent: 'Cells.',
              action: 'loop',
              foreach: { candidates: [{ kind: 'css', value: 'td' }] },
              do: [click('c_cell', 'a')],
            },
          ],
        },
      ]),
    );
    expect(source).toContain("await forEachItem('lp_cells', 100, await item.locator('td').all(), ");
    expect(source).toContain("await item.locator('a').click();");
  });

  it('keeps a guard inside a foreach scoped, and a while body unscoped', async () => {
    const { source } = await compile(
      wf([
        {
          id: 'lp_1',
          intent: 'Rows.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [
            {
              id: 'g_1',
              intent: 'If.',
              action: 'guard',
              if: { selectorVisible: '.x' },
              then: [click('c_1', '.x')],
              else: [click('c_2', '.y')],
            },
          ],
        },
        {
          id: 'lp_2',
          intent: 'More.',
          action: 'loop',
          while: { selectorVisible: '.more' },
          do: [click('c_3', '.more')],
        },
      ]),
    );
    expect(source).toContain("await item.locator('.x').click();");
    expect(source).toContain("await item.locator('.y').click();");
    expect(source).toContain("await page.locator('.more').click();");
  });
});

describe('compile: flow conditions', () => {
  it('evaluates guard, wait, assert and while conditions through conditionHolds', async () => {
    const { source } = await compile(
      wf([
        {
          id: 'g_1',
          intent: 'If.',
          action: 'guard',
          if: { urlMatches: '/orders' },
          then: [click('c_1', '.x')],
        },
        { id: 'w_1', intent: 'Wait.', action: 'wait', forCondition: { textPresent: 'Ready' } },
        { id: 'a_1', intent: 'Check.', action: 'assert', condition: { urlEquals: 'https://x/' } },
      ]),
    );
    expect(source).toContain("if (await conditionHolds(page, { urlMatches: '/orders' }, 'g_1')) {");
    expect(source).toContain(
      "await poll(async () => await conditionHolds(page, { textPresent: 'Ready' }, 'w_1'));",
    );
    expect(source).toContain(
      "assert(await conditionHolds(page, { urlEquals: 'https://x/' }, 'a_1'));",
    );
    expect(source).not.toContain('new RegExp');
  });

  it('still refuses responseStatus in a flow position at compile time', async () => {
    await expect(
      compile(
        wf([
          {
            id: 'lp_1',
            intent: 'While OK.',
            action: 'loop',
            while: { responseStatus: 200 },
            do: [click('c_1', '.x')],
          },
        ]),
      ),
    ).rejects.toThrow(/responseStatus/);
  });

  it('imports only the helpers the workflow uses', async () => {
    const plain = await compile(wf([click('c_1', '#go')]));
    expect(plain.source).toContain(
      "import { workflow, step, assert, poll } from '@sfysh/runtime';",
    );

    const loops = await compile(
      wf([
        {
          id: 'lp_1',
          intent: 'Rows.',
          action: 'loop',
          foreach: { candidates: [{ kind: 'css', value: 'tr' }] },
          do: [click('c_1', '.open')],
        },
      ]),
    );
    expect(loops.source).toContain(
      "import { workflow, step, assert, poll, forEachItem } from '@sfysh/runtime';",
    );
  });
});

describe('compile: bind names', () => {
  it.each(['page', 'emit', 'ctx', 'vault', 'item', 'extracted', 'step', 'conditionHolds'])(
    'refuses a bind that shadows %s',
    async (name) => {
      await expect(compile(wf([extract('x_1', name)]))).rejects.toThrow(
        /generated code already uses/,
      );
    },
  );

  it.each(['class', 'return', 'await', 'let', 'undefined'])(
    'refuses the reserved word %s',
    async (name) => {
      await expect(compile(wf([extract('x_1', name)]))).rejects.toThrow(/reserved word/);
    },
  );

  it('refuses the same bind twice, at any depth', async () => {
    await expect(
      compile(
        wf([
          extract('x_1', 'title'),
          {
            id: 'g_1',
            intent: 'If.',
            action: 'guard',
            if: { selectorVisible: '.x' },
            then: [extract('x_2', 'title')],
          },
        ]),
      ),
    ).rejects.toThrow(/both bind 'title'/);
  });

  it('accepts ordinary distinct names', async () => {
    const { source } = await compile(wf([extract('x_1', 'title'), extract('x_2', 'total')]));
    expect(source).toContain('const title = await step(');
    expect(source).toContain('const total = await step(');
  });

  it('raises CompilerError', async () => {
    await expect(compile(wf([extract('x_1', 'page')]))).rejects.toBeInstanceOf(CompilerError);
  });
});

describe('compile: role attributes', () => {
  it('passes unquoted numbers and flags with their types', async () => {
    const { source } = await compile(
      wf([
        click('c_1', "heading[level=2][name='Orders']", 'role'),
        click('c_2', "button[name='Save'][exact=true]", 'role'),
        click('c_3', 'button[name=Submit]', 'role'),
      ]),
    );
    expect(source).toContain("page.getByRole('heading', { level: 2, name: 'Orders' })");
    expect(source).toContain("page.getByRole('button', { name: 'Save', exact: true })");
    expect(source).toContain("page.getByRole('button', { name: 'Submit' })");
  });

  it('refuses a role selector with a part it cannot read, instead of dropping it', async () => {
    await expect(compile(wf([click('c_1', "button[name='Go' disabled]", 'role')]))).rejects.toThrow(
      /cannot be read: "disabled"/,
    );
  });
});
