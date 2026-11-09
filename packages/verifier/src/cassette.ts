// Cassette format for dry-run replay.
//
// A cassette is a snapshot of every Page-level query result observed during
// one real run of a workflow. During dry-run, FakePage looks up those results
// by a canonical call key so the runner can execute unchanged against canned
// responses, without hitting a live site.
//
// The recorder and FakePage both build keys with `callKey()` so they stay in
// lockstep. If the runner changes its Page method call order or args, the
// dry-run cassette will miss on the new key, which is intentional: that is a
// real behavioural change the healer should see.

export const CASSETTE_VERSION = 1 as const;

export interface Cassette {
  version: typeof CASSETTE_VERSION;
  workflowId: string;
  workflowName: string;
  /** ISO-8601 timestamp of when the cassette was recorded. */
  recordedAt: string;
  /**
   * Query results keyed by canonical call key. The key is the dotted locator
   * identity path plus the terminal method (see `callKey`).
   */
  queries: Record<string, CassetteValue>;
  /**
   * Side-effecting calls recorded in order for audit. Never consulted during
   * dry-run (click/goto/fill return void, so there is nothing to replay).
   */
  effects: CassetteEffect[];
}

export type CassetteValue =
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string-array'; value: string[] };

export interface CassetteEffect {
  call: string;
}

export class CassetteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteError';
  }
}

export class CassetteMissError extends CassetteError {
  readonly key: string;
  constructor(key: string) {
    super(`cassette has no recorded result for '${key}'`);
    this.name = 'CassetteMissError';
    this.key = key;
  }
}

/**
 * Build the canonical key for a call. Both the recorder and FakePage call
 * this so they index the same cassette entries.
 *
 * Examples:
 *   callKey([], 'url', []) === 'url'
 *   callKey([], 'goto', ['https://x']) === 'goto("https://x")'
 *   callKey(['locator("#foo")'], 'isVisible', []) === 'locator("#foo").isVisible'
 *   callKey(['locator("#foo")', 'nth(2)'], 'count', []) === 'locator("#foo").nth(2).count'
 */
export function callKey(path: readonly string[], method: string, args: readonly unknown[]): string {
  const terminal = segment(method, args);
  if (path.length === 0) return terminal;
  return [...path, terminal].join('.');
}

/**
 * Format a single path segment (locator constructor, nth call) into its
 * canonical string. Exposed so the recorder and FakePage build identical
 * identity paths when traversing locator chains.
 */
export function segment(method: string, args: readonly unknown[]): string {
  if (args.length === 0) return method;
  return `${method}(${canonicalArgs(args)})`;
}

function canonicalArgs(args: readonly unknown[]): string {
  return args.map(canonicalJson).join(',');
}

/**
 * JSON.stringify with deterministically sorted object keys. Needed so a
 * recorded call like `getByRole('button', { name: 'Submit', exact: true })`
 * produces the same key regardless of the backend's property insertion
 * order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Serialise a cassette to a JSON string ready to write to disk. Query keys
 * are sorted so recordings are byte-reproducible across runs.
 */
export function serialiseCassette(cassette: Cassette): string {
  const sortedKeys = Object.keys(cassette.queries).sort();
  const sortedQueries: Record<string, CassetteValue> = {};
  for (const key of sortedKeys) {
    sortedQueries[key] = cassette.queries[key]!;
  }
  const normalised: Cassette = {
    version: cassette.version,
    workflowId: cassette.workflowId,
    workflowName: cassette.workflowName,
    recordedAt: cassette.recordedAt,
    queries: sortedQueries,
    effects: cassette.effects.slice(),
  };
  return JSON.stringify(normalised, null, 2) + '\n';
}

/**
 * Parse a cassette from its JSON string form. Rejects anything that is not
 * a current-version cassette with the right shape; the error message points
 * at the first problem.
 */
export function parseCassette(raw: string): Cassette {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CassetteError(`cassette is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CassetteError('cassette must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CASSETTE_VERSION) {
    throw new CassetteError(
      `cassette version ${JSON.stringify(obj.version)} is not supported (expected ${CASSETTE_VERSION})`,
    );
  }
  for (const field of ['workflowId', 'workflowName', 'recordedAt'] as const) {
    if (typeof obj[field] !== 'string') {
      throw new CassetteError(`cassette field '${field}' must be a string`);
    }
  }
  if (typeof obj.queries !== 'object' || obj.queries === null || Array.isArray(obj.queries)) {
    throw new CassetteError("cassette field 'queries' must be an object");
  }
  for (const [key, value] of Object.entries(obj.queries as Record<string, unknown>)) {
    assertValue(key, value);
  }
  if (!Array.isArray(obj.effects)) {
    throw new CassetteError("cassette field 'effects' must be an array");
  }
  for (const [i, entry] of (obj.effects as unknown[]).entries()) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>).call !== 'string'
    ) {
      throw new CassetteError(`cassette effect at index ${i} must have a string 'call' field`);
    }
  }
  return obj as unknown as Cassette;
}

function assertValue(key: string, value: unknown): asserts value is CassetteValue {
  if (typeof value !== 'object' || value === null) {
    throw new CassetteError(`cassette query '${key}' must be an object`);
  }
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case 'string':
      if (typeof v.value !== 'string') {
        throw new CassetteError(
          `cassette query '${key}' of kind 'string' must have a string value`,
        );
      }
      return;
    case 'boolean':
      if (typeof v.value !== 'boolean') {
        throw new CassetteError(
          `cassette query '${key}' of kind 'boolean' must have a boolean value`,
        );
      }
      return;
    case 'number':
      if (typeof v.value !== 'number') {
        throw new CassetteError(
          `cassette query '${key}' of kind 'number' must have a number value`,
        );
      }
      return;
    case 'string-array':
      if (!Array.isArray(v.value) || (v.value as unknown[]).some((x) => typeof x !== 'string')) {
        throw new CassetteError(
          `cassette query '${key}' of kind 'string-array' must have an array of strings`,
        );
      }
      return;
    default:
      throw new CassetteError(`cassette query '${key}' has unknown kind ${JSON.stringify(v.kind)}`);
  }
}
