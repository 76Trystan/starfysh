import { describe, expect, it } from 'vitest';
import { checkEnvelope, MIN_ENVELOPE_RUNS, shapeOf } from '../src/index.js';

/** One run's outputs: a single extract of stock rows. */
const run = (rows: { sku: string; name: string; qty: number }[]) => [{ rows }];

const history = [
  run([
    { sku: 'A-001', name: 'Widget', qty: 3 },
    { sku: 'A-002', name: 'Sprocket', qty: 14 },
    { sku: 'B-010', name: 'Gear', qty: 7 },
  ]),
  run([
    { sku: 'A-001', name: 'Widget', qty: 5 },
    { sku: 'A-002', name: 'Sprocket', qty: 12 },
  ]),
  run([
    { sku: 'A-001', name: 'Widget', qty: 4 },
    { sku: 'B-010', name: 'Gear', qty: 9 },
    { sku: 'C-200', name: 'Flange', qty: 6 },
    { sku: 'C-201', name: 'Bracket', qty: 8 },
  ]),
];

const codes = (result: ReturnType<typeof checkEnvelope>) =>
  result.status === 'outside' ? result.deviations.map((d) => `${d.path}:${d.check}`) : [];

describe('shapeOf', () => {
  it.each([
    ['A-001', 'a-9'],
    ['Widget', 'a'],
    ['Order 1042', 'a 9'],
    ['  12.50 ', '9.9'],
    ['Lager Müller 7', 'a a 9'],
  ])('%s has shape %s', (text, shape) => {
    expect(shapeOf(text)).toBe(shape);
  });
});

describe('checkEnvelope', () => {
  it('skips the check, and says so, with too little history', () => {
    expect(checkEnvelope(history.slice(0, MIN_ENVELOPE_RUNS - 1), history[0]!)).toEqual({
      status: 'insufficient_history',
      runs: MIN_ENVELOPE_RUNS - 1,
    });
  });

  it('accepts a normal run with new values in familiar shapes and ranges', () => {
    const result = checkEnvelope(
      history,
      run([
        { sku: 'D-300', name: 'Nut', qty: 11 },
        { sku: 'A-001', name: 'Widget', qty: 2 },
      ]),
    );
    expect(result).toEqual({ status: 'within', runs: 3 });
  });

  it('catches a heal that reads the name column into sku', () => {
    const result = checkEnvelope(
      history,
      run([
        { sku: 'Widget', name: 'Widget', qty: 3 },
        { sku: 'Gear', name: 'Gear', qty: 7 },
      ]),
    );
    expect(codes(result)).toEqual(['*.rows.*.sku:shape']);
  });

  it('still catches it when the tolerance map ignores the column, because shape is not a value check', () => {
    const result = checkEnvelope(history, run([{ sku: 'Widget', name: 'Widget', qty: 3 }]), {
      '*.rows.*.sku': 'ignore',
    });
    expect(codes(result)).toEqual(['*.rows.*.sku:shape']);
  });

  it('catches a number far outside its range, unless the field is tolerated', () => {
    const wrong = run([{ sku: 'A-001', name: 'Widget', qty: 400 }]);
    expect(codes(checkEnvelope(history, wrong))).toEqual(['*.rows.*.qty:range']);
    expect(
      checkEnvelope(history, wrong, { '*.rows.*.qty': { kind: 'number', epsilon: 1 } }),
    ).toEqual({ status: 'within', runs: 3 });
  });

  it('catches a change of type, missing and unexpected fields', () => {
    const result = checkEnvelope(history, [
      { rows: [{ sku: 'A-001', name: 'Widget', qty: '3', extra: true }] },
    ]);
    expect(codes(result).sort()).toEqual(['*.rows.*.extra:unexpected', '*.rows.*.qty:type']);

    const missing = checkEnvelope(history, [{ rows: [{ sku: 'A-001', qty: 3 }] }]);
    expect(codes(missing)).toEqual(['*.rows.*.name:missing']);
  });

  it('catches a table that collapses or balloons, but allows ordinary variation', () => {
    const big = Array.from({ length: 20 }, (_, i) => ({ sku: `Z-${i}`, name: 'Bolt', qty: 5 }));
    expect(codes(checkEnvelope(history, run(big)))).toEqual(['*.rows:length']);
    // Two to four rows in history: one row is half the minimum, so it passes.
    expect(checkEnvelope(history, run([{ sku: 'A-001', name: 'Widget', qty: 3 }])).status).toBe(
      'within',
    );
  });

  it('does not report the fields of an empty table as missing', () => {
    const result = checkEnvelope(history, run([]));
    // An empty table is a length question only, and two rows minimum halves to one.
    expect(codes(result)).toEqual(['*.rows:length']);
  });

  it('reports an empty output list as every field missing', () => {
    expect(codes(checkEnvelope(history, []))).toContain('*.rows:missing');
  });

  it('never quotes a value in a message', () => {
    const result = checkEnvelope(history, run([{ sku: 'SECRETVALUE', name: 'x', qty: 99999 }]));
    expect(result.status).toBe('outside');
    expect(JSON.stringify(result)).not.toMatch(/SECRETVALUE|99999/);
  });
});
