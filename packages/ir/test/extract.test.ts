import { describe, it, expect } from 'vitest';
import { planExtract } from '../src/index.js';

describe('planExtract', () => {
  it('reads a string schema as a single value', () => {
    expect(planExtract({ type: 'string' })).toEqual({ kind: 'value' });
  });

  it('reads an array of strings, or an array with no items, as a flat list', () => {
    expect(planExtract({ type: 'array', items: { type: 'string' } })).toEqual({ kind: 'list' });
    expect(planExtract({ type: 'array' })).toEqual({ kind: 'list' });
  });

  it('reads an array of objects as a table, one typed column per property', () => {
    expect(
      planExtract({
        type: 'array',
        items: {
          type: 'object',
          required: ['sku'],
          properties: {
            sku: { type: 'string' },
            qty: { type: 'number' },
            count: { type: 'integer' },
            inStock: { type: 'boolean', description: 'ignored' },
          },
        },
      }),
    ).toEqual({
      kind: 'table',
      columns: { sku: 'string', qty: 'number', count: 'number', inStock: 'boolean' },
    });
  });

  it('keeps the property order as the column order', () => {
    const plan = planExtract({
      type: 'array',
      items: { type: 'object', properties: { b: { type: 'string' }, a: { type: 'string' } } },
    });
    expect(plan.kind === 'table' && Object.keys(plan.columns)).toEqual(['b', 'a']);
  });

  it('reads a bare column map as a table', () => {
    expect(planExtract({ sku: 'string', qty: 'number', ok: 'boolean' })).toEqual({
      kind: 'table',
      columns: { sku: 'string', qty: 'number', ok: 'boolean' },
    });
  });

  it('keeps a column called __proto__ as a column', () => {
    const schema = JSON.parse(
      '{"type":"array","items":{"type":"object","properties":{"__proto__":{"type":"string"}}}}',
    );
    const plan = planExtract(schema);
    expect(plan.kind).toBe('table');
    if (plan.kind !== 'table') return;
    expect(Object.keys(plan.columns)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(plan.columns)).toBe(Object.prototype);
  });

  it.each([
    [
      'a column that is an object',
      { type: 'array', items: { type: 'object', properties: { address: { type: 'object' } } } },
      /column 'address'/,
    ],
    [
      'a column that is an array',
      { type: 'array', items: { type: 'object', properties: { tags: { type: 'array' } } } },
      /column 'tags'/,
    ],
    [
      'a column with no type',
      { type: 'array', items: { type: 'object', properties: { sku: {} } } },
      /column 'sku'/,
    ],
    [
      'an array of objects with no properties',
      { type: 'array', items: { type: 'object' } },
      /items\.properties/,
    ],
    [
      'an array of objects with empty properties',
      { type: 'array', items: { type: 'object', properties: {} } },
      /no columns/,
    ],
    [
      'an array of numbers',
      { type: 'array', items: { type: 'number' } },
      /array items of type "number"/,
    ],
    [
      'a single object',
      { type: 'object', properties: { title: { type: 'string' } } },
      /schema type "object"/,
    ],
    ['a number', { type: 'number' }, /schema type "number"/],
    ['an empty schema', {}, /not a column map/],
    ['a column map with an unknown type', { sku: 'string', when: 'date' }, /not a column map/],
    [
      'items that is not an object',
      { type: 'array', items: 'string' },
      /'items' must be a schema object/,
    ],
  ])('refuses %s', (_label, schema, reason) => {
    const plan = planExtract(schema);
    expect(plan.kind).toBe('unsupported');
    expect(plan.kind === 'unsupported' && plan.reason).toMatch(reason);
  });

  it.each([null, undefined, 'string', 42, []])('refuses a non-object schema (%s)', (schema) => {
    expect(planExtract(schema).kind).toBe('unsupported');
  });
});
