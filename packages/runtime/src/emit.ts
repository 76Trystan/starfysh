// Typed extraction helper and output types.
//
// Generated code uses `ctx.emit.table(locator, schema)` and
// `ctx.emit.output(value)`. The emit sink is bound to the per-run
// WorkflowContext (ADR 0010), so the output buffer and the table
// extractor live together on the context rather than at module scope.
//
// Extraction is the injection boundary: page content flows into typed
// schema fields with validation, never into a model's action loop.
// If extraction fails validation, the workflow fails loudly.

import type { Locator } from './types.js';

/** Primitive type a table column is coerced to. */
export type ColumnType = 'string' | 'number' | 'boolean';

/**
 * A column with header text other than its name. `headers` are the
 * header cells the column may appear under, tried after the name itself.
 */
export interface ColumnSpec {
  type: ColumnType;
  headers?: readonly string[];
}

/**
 * Column schema for `ctx.emit.table`. Maps each output field to the type
 * its cells coerce to ('string' is pass-through, 'number' and 'boolean'
 * coerce or fail), or to a `ColumnSpec` naming other header text the
 * column may appear under.
 *
 * A field is matched to a header cell by its name and its `headers`:
 * first exactly (after trimming), then ignoring case, runs of whitespace
 * and Unicode compatibility forms. Two header cells matching one field at
 * the same step is an error, never a guess, because a guess here is a
 * wrong-column read.
 */
export type ColumnSchema = Record<string, ColumnType | ColumnSpec>;

type CellType<C> = C extends ColumnSpec ? C['type'] : C;

/**
 * Infer the row type from a column schema literal.
 * `{ sku: 'string', qty: { type: 'number', headers: ['Quantity'] } }`
 * becomes `{ sku: string; qty: number }`.
 */
export type TableRow<S extends ColumnSchema> = {
  [K in keyof S]: CellType<S[K]> extends 'string'
    ? string
    : CellType<S[K]> extends 'number'
      ? number
      : CellType<S[K]> extends 'boolean'
        ? boolean
        : never;
};

/**
 * Error thrown when extraction fails validation. Carries enough context
 * for triage to classify the failure precisely.
 */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/**
 * Extract rows from a table locator using the given column schema.
 * Header row determines column order; data rows are coerced per schema.
 * Missing or unparseable cells raise an ExtractionError.
 *
 * Called via `ctx.emit.table(locator, schema)` from generated code; the
 * context's emit sink delegates here.
 */
export async function extractTable<S extends ColumnSchema>(
  locator: Locator,
  schema: S,
): Promise<TableRow<S>[]> {
  const headers = await locator.locator('thead th, tr:first-child th').allTextContents();
  const trimmedHeaders = headers.map((h) => h.trim());
  const schemaKeys = Object.keys(schema);

  const columnIndex: Record<string, number> = {};
  for (const key of schemaKeys) {
    columnIndex[key] = findColumn(key, schema[key]!, trimmedHeaders);
  }

  const rows: TableRow<S>[] = [];
  const bodyRows = locator.locator('tbody tr, tr:not(:first-child)');
  const rowCount = await bodyRows.count();

  for (let i = 0; i < rowCount; i++) {
    const cells = await bodyRows.nth(i).locator('td, th').allTextContents();
    const row: Record<string, unknown> = {};
    for (const key of schemaKeys) {
      const raw = cells[columnIndex[key]!]?.trim() ?? '';
      row[key] = coerce(raw, columnType(schema[key]!), key);
    }
    rows.push(row as TableRow<S>);
  }

  return rows;
}

/**
 * Extract a single text value from a locator. Returns the first element's
 * text content, or null if the locator matches nothing. Covers the parser's
 * `textContent`, `innerText`, and `inputValue` extract patterns, which all
 * map to `{ type: 'string' }` in the IR.
 */
export async function extractValue(locator: Locator): Promise<string | null> {
  const texts = await locator.allTextContents();
  return texts[0] ?? null;
}

/**
 * Extract a flat list of text values from a locator. Returns one string per
 * matched element. Covers the parser's `allTextContents` extract pattern,
 * which maps to `{ type: 'array', items: { type: 'string' } }` in the IR.
 */
export async function extractList(locator: Locator): Promise<string[]> {
  return locator.allTextContents();
}

function columnType(column: ColumnType | ColumnSpec): ColumnType {
  return typeof column === 'string' ? column : column.type;
}

/**
 * Header text compared loosely: Unicode compatibility forms folded (NFKC),
 * whitespace runs (non-breaking spaces included) collapsed to one space,
 * trimmed, and lower-cased.
 */
export function normaliseHeader(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Index of the header cell a field reads from. Exact matches on the name
 * or an alias win; loose matches (`normaliseHeader`) are tried only when
 * there is no exact one. More than one cell at the winning step throws.
 */
function findColumn(key: string, column: ColumnType | ColumnSpec, headers: string[]): number {
  const names = [key, ...(typeof column === 'string' ? [] : (column.headers ?? []))];
  const exact = matching(headers, (h) => names.includes(h));
  const loose = names.map(normaliseHeader);
  const found =
    exact.length > 0 ? exact : matching(headers, (h) => loose.includes(normaliseHeader(h)));

  const tried = names.map((n) => `'${n}'`).join(', ');
  if (found.length === 0) {
    throw new ExtractionError(
      `Column '${key}' not found in table headers (looked for ${tried}). Headers were: ${headers.join(', ')}`,
    );
  }
  if (found.length > 1) {
    throw new ExtractionError(
      `Column '${key}' matches more than one table header (${found.map((i) => `'${headers[i]}'`).join(', ')}); give it a header alias that names one.`,
    );
  }
  return found[0]!;
}

function matching(headers: string[], test: (header: string) => boolean): number[] {
  const indices: number[] = [];
  headers.forEach((h, i) => {
    if (test(h)) indices.push(i);
  });
  return indices;
}

function coerce(raw: string, type: 'string' | 'number' | 'boolean', field: string): unknown {
  if (type === 'string') return raw;
  if (type === 'number') {
    const cleaned = raw.replace(/[,$£€\s]/g, '');
    const parsed = Number(cleaned);
    if (Number.isNaN(parsed)) {
      throw new ExtractionError(`Could not parse '${raw}' as number for field '${field}'`);
    }
    return parsed;
  }
  if (type === 'boolean') {
    const lowered = raw.toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(lowered)) return true;
    if (['false', 'no', 'n', '0', ''].includes(lowered)) return false;
    throw new ExtractionError(`Could not parse '${raw}' as boolean for field '${field}'`);
  }
  throw new ExtractionError(`Unknown field type '${type as string}' for field '${field}'`);
}
