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

/**
 * Column schema for `ctx.emit.table`. Maps column header name to the
 * primitive type the column should coerce to. 'string' is pass-through,
 * 'number' and 'boolean' coerce or fail.
 */
export type ColumnSchema = Record<string, 'string' | 'number' | 'boolean'>;

/**
 * Infer the row type from a column schema literal.
 * `{ sku: 'string', qty: 'number' }` becomes `{ sku: string; qty: number }`.
 */
export type TableRow<S extends ColumnSchema> = {
  [K in keyof S]: S[K] extends 'string'
    ? string
    : S[K] extends 'number'
      ? number
      : S[K] extends 'boolean'
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
    const index = trimmedHeaders.indexOf(key);
    if (index === -1) {
      throw new ExtractionError(
        `Column '${key}' not found in table headers. Headers were: ${trimmedHeaders.join(', ')}`,
      );
    }
    columnIndex[key] = index;
  }

  const rows: TableRow<S>[] = [];
  const bodyRows = locator.locator('tbody tr, tr:not(:first-child)');
  const rowCount = await bodyRows.count();

  for (let i = 0; i < rowCount; i++) {
    const cells = await bodyRows.nth(i).locator('td, th').allTextContents();
    const row: Record<string, unknown> = {};
    for (const key of schemaKeys) {
      const raw = cells[columnIndex[key]!]?.trim() ?? '';
      row[key] = coerce(raw, schema[key]!, key);
    }
    rows.push(row as TableRow<S>);
  }

  return rows;
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
