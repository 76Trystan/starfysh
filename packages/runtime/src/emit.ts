// Typed extraction and workflow output.
//
// Generated code calls:
//   const rows = await emit.table(page.getByRole('table'), { sku: 'string', qty: 'number' });
//   emit.output(rows.filter(r => r.qty < 10));
//
// Extraction is the injection boundary: page content flows into typed
// schema fields with validation, never into a model's action loop.
// If extraction fails validation, the workflow fails loudly.

import type { Locator } from 'playwright-core';

/**
 * Column schema for emit.table. Maps column header name to the primitive
 * type the column should coerce to. 'string' is pass-through, 'number' and
 * 'boolean' coerce or fail.
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

const outputs: unknown[] = [];

/**
 * Record a workflow output. Multiple calls accumulate; the full array is
 * flushed to stdout as JSON when `flushOutputs` is called at the end of
 * the workflow. In tests, use `drainOutputs` instead.
 */
function output<T>(value: T): void {
  outputs.push(value);
}

/**
 * Flush accumulated outputs to stdout as a single JSON line. Called by
 * generated code at the end of the workflow test. If COMPILE_OUTPUT_FILE
 * is set, writes there instead.
 */
export async function flushOutputs(): Promise<void> {
  if (outputs.length === 0) return;
  const serialised = JSON.stringify(outputs.length === 1 ? outputs[0] : outputs);
  const outFile = process.env['COMPILE_OUTPUT_FILE'];
  if (outFile) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outFile, serialised, 'utf-8');
  } else {
    process.stdout.write(serialised + '\n');
  }
  outputs.length = 0;
}

/**
 * Clear accumulated outputs without writing. Returns the drained values.
 * Intended for test setup/teardown; generated code uses flushOutputs.
 */
export function drainOutputs(): unknown[] {
  const copy = outputs.slice();
  outputs.length = 0;
  return copy;
}

/**
 * Extract rows from a table locator using the given column schema.
 * Header row determines column order; data rows are coerced per schema.
 * Missing or unparseable cells raise an ExtractionError.
 */
async function table<S extends ColumnSchema>(locator: Locator, schema: S): Promise<TableRow<S>[]> {
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

/**
 * Error thrown when extraction fails validation. Carries enough context
 * for the verifier to classify the failure precisely.
 */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/**
 * The emit namespace: workflow-facing helpers that generated code calls.
 */
export const emit = {
  table,
  output,
};
