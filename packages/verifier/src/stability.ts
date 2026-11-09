// Compare outputs across N replays. A stable workflow produces the same
// output every run; if it does not, the verifier surfaces each drifted
// field so the author can either widen the tolerance or declare the
// field inherently variable (timestamps, request ids).
//
// Tolerance paths use dotted segments with "*" as a wildcard for array
// indices or map keys:
//   rows.*.price            every row's price field
//   rows.0.price            the first row's price
//   metadata.*              every top-level metadata field

import type { DriftField, StabilityReport, ToleranceMap, ToleranceRule } from './types.js';

export function compareOutputs(runs: unknown[][], tolerance?: ToleranceMap): StabilityReport {
  if (runs.length < 2) {
    return { stable: true, drift: [] };
  }

  const drift: DriftField[] = [];
  const baseline = runs[0]!;
  for (let i = 1; i < runs.length; i++) {
    walk('', baseline, runs[i]!, tolerance ?? {}, drift);
  }

  return deduplicateDrift(drift);
}

function walk(
  path: string,
  a: unknown,
  b: unknown,
  tolerance: ToleranceMap,
  drift: DriftField[],
): void {
  const rule = resolveRule(path, tolerance);
  if (rule === 'ignore') return;

  if (rule && typeof rule === 'object') {
    if (rule.kind === 'number') {
      if (typeof a !== 'number' || typeof b !== 'number' || Math.abs(a - b) > rule.epsilon) {
        recordDrift(drift, path, a, b);
      }
      return;
    }
    if (rule.kind === 'set') {
      if (!setEqual(a, b)) recordDrift(drift, path, a, b);
      return;
    }
  }

  if (a === b) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      recordDrift(drift, path, a, b);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      walk(join(path, String(i)), a[i], b[i], tolerance, drift);
    }
    return;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      walk(join(path, k), a[k], b[k], tolerance, drift);
    }
    return;
  }

  if (!deepEqual(a, b)) recordDrift(drift, path, a, b);
}

function resolveRule(path: string, tolerance: ToleranceMap): ToleranceRule | undefined {
  if (tolerance[path]) return tolerance[path];
  for (const [pattern, rule] of Object.entries(tolerance)) {
    if (pattern.includes('*') && matchesPattern(path, pattern)) return rule;
  }
  return undefined;
}

function matchesPattern(path: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .split('.')
        .map((seg) => (seg === '*' ? '[^.]+' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
        .join('\\.') +
      '$',
  );
  return regex.test(path);
}

function recordDrift(drift: DriftField[], path: string, a: unknown, b: unknown): void {
  drift.push({ path, values: [a, b] });
}

function deduplicateDrift(drift: DriftField[]): StabilityReport {
  const byPath = new Map<string, Set<string>>();
  for (const d of drift) {
    const bucket = byPath.get(d.path) ?? new Set<string>();
    for (const v of d.values) bucket.add(stableStringify(v));
    byPath.set(d.path, bucket);
  }
  const merged: DriftField[] = [];
  for (const [path, set] of byPath) {
    merged.push({ path, values: [...set].map((s) => JSON.parse(s)) });
  }
  return { stable: merged.length === 0, drift: merged };
}

function setEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const bagA = a.map(stableStringify).sort();
  const bagB = b.map(stableStringify).sort();
  for (let i = 0; i < bagA.length; i++) if (bagA[i] !== bagB[i]) return false;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_, value) => {
    if (isPlainObject(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) sorted[k] = value[k];
      return sorted;
    }
    return value;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function join(a: string, b: string): string {
  return a ? `${a}.${b}` : b;
}
