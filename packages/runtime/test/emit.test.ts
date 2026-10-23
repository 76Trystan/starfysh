import { describe, it, expect, beforeEach } from 'vitest';
import type { Locator } from 'playwright-core';
import { emit, drainOutputs, ExtractionError } from '../src/index.js';

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

describe('emit.table', () => {
  it('extracts rows according to the column schema', async () => {
    const loc = mockTableLocator({
      headers: ['sku', 'name', 'qty', 'reorderLevel'],
      rows: [
        ['A-001', 'Widget', '12', '20'],
        ['A-002', 'Sprocket', '45', '30'],
      ],
    });

    const rows = await emit.table(loc, {
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

  it('strips thousands separators from numbers', async () => {
    const loc = mockTableLocator({
      headers: ['label', 'amount'],
      rows: [['Sales', '$1,250.50']],
    });
    const rows = await emit.table(loc, { label: 'string', amount: 'number' });
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
    const rows = await emit.table(loc, { item: 'string', active: 'boolean' });
    expect(rows.map((r) => r.active)).toEqual([true, false, true]);
  });

  it('throws ExtractionError when a required column is missing', async () => {
    const loc = mockTableLocator({
      headers: ['sku', 'name'],
      rows: [['A', 'Widget']],
    });
    await expect(emit.table(loc, { sku: 'string', missingCol: 'string' })).rejects.toThrow(
      ExtractionError,
    );
  });

  it('throws ExtractionError when a number cannot be parsed', async () => {
    const loc = mockTableLocator({
      headers: ['qty'],
      rows: [['twelve']],
    });
    await expect(emit.table(loc, { qty: 'number' })).rejects.toThrow(ExtractionError);
  });
});

describe('emit.output + drainOutputs', () => {
  beforeEach(() => {
    drainOutputs();
  });

  it('accumulates outputs across multiple calls', () => {
    emit.output({ a: 1 });
    emit.output({ b: 2 });
    expect(drainOutputs()).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('drainOutputs clears the buffer', () => {
    emit.output('x');
    drainOutputs();
    expect(drainOutputs()).toEqual([]);
  });

  it('accepts arbitrary serialisable values', () => {
    emit.output([1, 2, 3]);
    emit.output('string');
    emit.output(null);
    expect(drainOutputs()).toEqual([[1, 2, 3], 'string', null]);
  });
});
