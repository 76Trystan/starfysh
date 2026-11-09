import { describe, it, expect } from 'vitest';
import {
  CASSETTE_VERSION,
  CassetteError,
  callKey,
  canonicalJson,
  parseCassette,
  segment,
  serialiseCassette,
  type Cassette,
} from '../src/cassette.js';

function cassette(overrides: Partial<Cassette> = {}): Cassette {
  return {
    version: CASSETTE_VERSION,
    workflowId: 'wf_test',
    workflowName: 'Test Workflow',
    recordedAt: '2026-11-09T12:00:00.000Z',
    queries: {},
    effects: [],
    ...overrides,
  };
}

describe('callKey and segment', () => {
  it('builds a page-level key with no args', () => {
    expect(callKey([], 'url', [])).toBe('url');
  });

  it('builds a page-level key with string args', () => {
    expect(callKey([], 'goto', ['https://example.com/'])).toBe('goto("https://example.com/")');
  });

  it('builds a single-segment locator key', () => {
    expect(callKey(['locator("#foo")'], 'isVisible', [])).toBe('locator("#foo").isVisible');
  });

  it('builds a nested locator key', () => {
    const path = [segment('locator', ['#foo']), segment('nth', [2]), segment('locator', ['span'])];
    expect(callKey(path, 'count', [])).toBe('locator("#foo").nth(2).locator("span").count');
  });

  it('is identical for same object args regardless of key order', () => {
    const a = segment('getByRole', ['button', { name: 'Submit', exact: true }]);
    const b = segment('getByRole', ['button', { exact: true, name: 'Submit' }]);
    expect(a).toBe(b);
  });
});

describe('canonicalJson', () => {
  it('stringifies primitives using JSON rules', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('sorts object keys', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined-valued fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('recurses into nested objects and arrays', () => {
    expect(canonicalJson({ x: [1, { b: 2, a: 3 }] })).toBe('{"x":[1,{"a":3,"b":2}]}');
  });
});

describe('serialise/parse round-trip', () => {
  it('round-trips a populated cassette byte-for-byte', () => {
    const original = cassette({
      queries: {
        url: { kind: 'string', value: 'https://example.com/done' },
        'locator("#submit").isVisible': { kind: 'boolean', value: true },
        'getByText("Submitted").count': { kind: 'number', value: 1 },
      },
      effects: [{ call: 'goto("https://example.com/")' }, { call: 'locator("#submit").click' }],
    });
    const serialised = serialiseCassette(original);
    const parsed = parseCassette(serialised);
    expect(parsed).toEqual(original);
    expect(serialiseCassette(parsed)).toBe(serialised);
  });

  it('sorts query keys when serialising so recordings are reproducible', () => {
    const c = cassette({
      queries: {
        z: { kind: 'string', value: 'z' },
        a: { kind: 'string', value: 'a' },
        m: { kind: 'string', value: 'm' },
      },
    });
    const serialised = serialiseCassette(c);
    const keysInOrder = serialised.match(/"([a-z])": \{/g);
    expect(keysInOrder).toEqual(['"a": {', '"m": {', '"z": {']);
  });

  it('writes a trailing newline for POSIX friendliness', () => {
    const serialised = serialiseCassette(cassette());
    expect(serialised.endsWith('\n')).toBe(true);
  });
});

describe('parseCassette error cases', () => {
  it('rejects non-JSON input', () => {
    expect(() => parseCassette('not json')).toThrow(CassetteError);
  });

  it('rejects a non-object top level', () => {
    expect(() => parseCassette('[]')).toThrow(/must be a JSON object/);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseCassette(JSON.stringify({ ...cassette(), version: 99 }))).toThrow(
      /version 99 is not supported/,
    );
  });

  it('rejects when a required field is missing or wrong-typed', () => {
    const base = cassette();
    const serialised = JSON.stringify({ ...base, workflowId: 123 });
    expect(() => parseCassette(serialised)).toThrow(/workflowId.*must be a string/);
  });

  it('rejects a query of unknown kind', () => {
    const serialised = JSON.stringify({
      ...cassette(),
      queries: { x: { kind: 'bogus', value: 1 } },
    });
    expect(() => parseCassette(serialised)).toThrow(/unknown kind/);
  });

  it('rejects a query where kind and value shape mismatch', () => {
    const serialised = JSON.stringify({
      ...cassette(),
      queries: { x: { kind: 'boolean', value: 'nope' } },
    });
    expect(() => parseCassette(serialised)).toThrow(/boolean.*boolean value/);
  });

  it('rejects an effect without a string call field', () => {
    const serialised = JSON.stringify({ ...cassette(), effects: [{ call: 42 }] });
    expect(() => parseCassette(serialised)).toThrow(/effect at index 0/);
  });
});
