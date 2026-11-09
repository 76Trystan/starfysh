import { describe, it, expect } from 'vitest';
import { compareOutputs } from '../src/stability.js';

describe('compareOutputs', () => {
  it('reports stable when fewer than two runs', () => {
    const r = compareOutputs([[{ a: 1 }]]);
    expect(r.stable).toBe(true);
    expect(r.drift).toEqual([]);
  });

  it('reports stable when all runs match exactly', () => {
    const runs = [[{ a: 1, b: 2 }], [{ a: 1, b: 2 }], [{ a: 1, b: 2 }]];
    expect(compareOutputs(runs).stable).toBe(true);
  });

  it('flags a top-level drifted field', () => {
    const runs = [[{ a: 1 }], [{ a: 2 }]];
    const r = compareOutputs(runs);
    expect(r.stable).toBe(false);
    expect(r.drift).toEqual([{ path: '0.a', values: [1, 2] }]);
  });

  it('flags a nested drifted field with dotted path', () => {
    const runs = [[{ row: { price: 10 } }], [{ row: { price: 12 } }]];
    const r = compareOutputs(runs);
    expect(r.drift).toEqual([{ path: '0.row.price', values: [10, 12] }]);
  });

  it('ignores fields listed with tolerance=ignore', () => {
    const runs = [[{ ts: 100, price: 10 }], [{ ts: 200, price: 10 }]];
    const r = compareOutputs(runs, { '0.ts': 'ignore' });
    expect(r.stable).toBe(true);
  });

  it('respects numeric epsilon tolerance', () => {
    const runs = [[{ price: 10.0 }], [{ price: 10.005 }]];
    const withinEpsilon = compareOutputs(runs, { '0.price': { kind: 'number', epsilon: 0.01 } });
    expect(withinEpsilon.stable).toBe(true);
    const outsideEpsilon = compareOutputs(runs, { '0.price': { kind: 'number', epsilon: 0.001 } });
    expect(outsideEpsilon.stable).toBe(false);
  });

  it('respects set tolerance for arrays', () => {
    const runs = [[{ tags: ['a', 'b', 'c'] }], [{ tags: ['c', 'a', 'b'] }]];
    const asSet = compareOutputs(runs, { '0.tags': { kind: 'set' } });
    expect(asSet.stable).toBe(true);
    const strict = compareOutputs(runs);
    expect(strict.stable).toBe(false);
  });

  it('wildcard matches any index segment', () => {
    const runs = [
      [{ rows: [{ price: 10 }, { price: 20 }] }],
      [{ rows: [{ price: 10.5 }, { price: 19.5 }] }],
    ];
    const r = compareOutputs(runs, { '0.rows.*.price': { kind: 'number', epsilon: 1 } });
    expect(r.stable).toBe(true);
  });

  it('reports array length mismatches as drift on the array path', () => {
    const runs = [[{ rows: [1, 2] }], [{ rows: [1, 2, 3] }]];
    const r = compareOutputs(runs);
    const paths = r.drift.map((d) => d.path);
    expect(paths).toContain('0.rows');
  });

  it('merges duplicate drift reports across replays', () => {
    const runs = [[{ a: 1 }], [{ a: 2 }], [{ a: 3 }]];
    const r = compareOutputs(runs);
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]?.path).toBe('0.a');
    expect(r.drift[0]?.values.sort()).toEqual([1, 2, 3]);
  });

  it('treats key-reordered objects as equal', () => {
    const runs = [[{ a: 1, b: 2 }], [{ b: 2, a: 1 }]];
    expect(compareOutputs(runs).stable).toBe(true);
  });
});
