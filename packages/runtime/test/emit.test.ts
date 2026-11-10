import { describe, it, expect } from 'vitest';
import type { Locator, Page } from '../src/index.js';
import { ExtractionError, createWorkflowContext, extractTable } from '../src/index.js';

/**
 * Minimal Locator mock for extraction tests. Supports .locator() chaining
 * for CSS selectors against a fake table structure.
 */
function mockTableLocator(table: { headers: string[]; rows: string[][] }): Locator {
  const headerLocator = {
    allTextContents: async () => table.headers,
  };
  const bodyRowsLocator = {
    count: async () => table.rows.length,
    nth: (i: number) => ({
      locator: () => ({
        allTextContents: async () => table.rows[i] ?? [],
      }),
    }),
  };

  return {
    locator: (selector: string) => {
      if (selector.includes('th')) return headerLocator;
      if (selector.includes('tr')) return bodyRowsLocator;
      return headerLocator;
    },
  } as unknown as Locator;
}

const stubPage: Page = {
  goto: async () => undefined,
  url: () => 'about:blank',
  locator: () => ({}) as unknown as Locator,
  getByRole: () => ({}) as unknown as Locator,
  getByTestId: () => ({}) as unknown as Locator,
  getByText: () => ({}) as unknown as Locator,
  getByLabel: () => ({}) as unknown as Locator,
  waitForTimeout: async () => undefined,
};

describe('extractTable (pure helper + ctx.emit.table)', () => {
  it('extracts rows according to the column schema via extractTable', async () => {
    const loc = mockTableLocator({
      headers: ['sku', 'name', 'qty', 'reorderLevel'],
      rows: [
        ['A-001', 'Widget', '12', '20'],
        ['A-002', 'Sprocket', '45', '30'],
      ],
    });

    const rows = await extractTable(loc, {
      sku: 'string',
      name: 'string',
      qty: 'number',
      reorderLevel: 'number',
    });

    expect(rows).toEqual([
      { sku: 'A-001', name: 'Widget', qty: 12, reorderLevel: 20 },
      { sku: 'A-002', name: 'Sprocket', qty: 45, reorderLevel: 30 },
    ]);
  });

  it('ctx.emit.table delegates to the same extractor', async () => {
    const loc = mockTableLocator({
      headers: ['sku'],
      rows: [['A-001'], ['A-002']],
    });
    const ctx = createWorkflowContext({ page: stubPage });
    const rows = await ctx.emit.table(loc, { sku: 'string' });
    expect(rows).toEqual([{ sku: 'A-001' }, { sku: 'A-002' }]);
  });

  it('strips thousands separators from numbers', async () => {
    const loc = mockTableLocator({
      headers: ['label', 'amount'],
      rows: [['Sales', '$1,250.50']],
    });
    const rows = await extractTable(loc, { label: 'string', amount: 'number' });
    expect(rows[0]).toEqual({ label: 'Sales', amount: 1250.5 });
  });

  it('coerces booleans from common string forms', async () => {
    const loc = mockTableLocator({
      headers: ['item', 'active'],
      rows: [
        ['A', 'true'],
        ['B', 'no'],
        ['C', '1'],
      ],
    });
    const rows = await extractTable(loc, { item: 'string', active: 'boolean' });
    expect(rows.map((r) => r.active)).toEqual([true, false, true]);
  });

  it('throws ExtractionError when a required column is missing', async () => {
    const loc = mockTableLocator({
      headers: ['sku', 'name'],
      rows: [['A', 'Widget']],
    });
    await expect(extractTable(loc, { sku: 'string', missingCol: 'string' })).rejects.toThrow(
      ExtractionError,
    );
  });

  it('throws ExtractionError when a number cannot be parsed', async () => {
    const loc = mockTableLocator({
      headers: ['qty'],
      rows: [['twelve']],
    });
    await expect(extractTable(loc, { qty: 'number' })).rejects.toThrow(ExtractionError);
  });
});

describe('WorkflowContext.emit.output + ctx.drainOutputs', () => {
  it('accumulates outputs across multiple calls on the same context', () => {
    const ctx = createWorkflowContext({ page: stubPage });
    ctx.emit.output({ a: 1 });
    ctx.emit.output({ b: 2 });
    expect(ctx.drainOutputs()).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('drainOutputs clears the buffer', () => {
    const ctx = createWorkflowContext({ page: stubPage });
    ctx.emit.output('x');
    ctx.drainOutputs();
    expect(ctx.drainOutputs()).toEqual([]);
  });

  it('accepts arbitrary serialisable values', () => {
    const ctx = createWorkflowContext({ page: stubPage });
    ctx.emit.output([1, 2, 3]);
    ctx.emit.output('string');
    ctx.emit.output(null);
    expect(ctx.drainOutputs()).toEqual([[1, 2, 3], 'string', null]);
  });

  it('isolates outputs between two concurrent contexts', () => {
    const ctxA = createWorkflowContext({ page: stubPage });
    const ctxB = createWorkflowContext({ page: stubPage });
    ctxA.emit.output('a1');
    ctxB.emit.output('b1');
    ctxA.emit.output('a2');
    expect(ctxA.drainOutputs()).toEqual(['a1', 'a2']);
    expect(ctxB.drainOutputs()).toEqual(['b1']);
  });
});
