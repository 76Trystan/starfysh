// How an `extract` step's schema decides the way the page is read.
//
// The compiler and the interpreter both have to turn an extract schema into
// one of three reads: a single text value, a flat list of text values, or a
// table of typed rows. The rule lives here so they cannot disagree.

/** Primitive type a table column is coerced to. */
export type ColumnType = 'string' | 'number' | 'boolean';

/** A table column whose header text differs from its name. Same shape as the runtime's `ColumnSpec`. */
export interface ColumnSpec {
  type: ColumnType;
  /** Header cells the column may appear under, tried after the column name. */
  headers: string[];
}

/** JSON Schema keyword on a table column property naming its header text. */
export const HEADER_KEYWORD = 'x-header';

export type ExtractPlan =
  /** One text value: the first matched element's text. */
  | { kind: 'value' }
  /** One text value per matched element. */
  | { kind: 'list' }
  /** Typed rows read from a table, one object per row, keyed by column. */
  | { kind: 'table'; columns: Record<string, ColumnType | ColumnSpec> }
  /** The schema does not describe a read the runtime can perform. */
  | { kind: 'unsupported'; reason: string };

/**
 * Decide how to read the page for an extract schema.
 *
 * | Schema | Read |
 * | --- | --- |
 * | `{ type: 'string' }` | `value` |
 * | `{ type: 'array' }` with no `items`, or `items` of type `string` | `list` |
 * | `{ type: 'array', items: { type: 'object', properties } }` | `table`, one column per property |
 * | A bare column map such as `{ sku: 'string', qty: 'number' }` | `table` |
 *
 * For a table, each property's JSON Schema type becomes the column type:
 * `string`, `number`, `integer` (read as `number`) or `boolean`. A property
 * of any other type makes the whole schema `unsupported`, because there is
 * no honest way to coerce a table cell into an object or an array.
 *
 * A property may name the header text it appears under with `x-header`,
 * a string or a list of strings: `{ "type": "string", "x-header": "Stock code" }`.
 * The column is then a `ColumnSpec`. Without it the column is its bare
 * type, so plans for existing workflows are unchanged. Header matching
 * itself (exact first, then ignoring case and spacing) is the runtime's.
 *
 * A column map whose first column is literally named `type` is read as a
 * JSON Schema, not a column map. Name the column something else.
 */
export function planExtract(schema: unknown): ExtractPlan {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return unsupported('extract schema must be an object');
  }
  const s = schema as Record<string, unknown>;

  if (s['type'] === 'string') return { kind: 'value' };

  if (s['type'] === 'array') {
    const items = s['items'];
    if (items === undefined) return { kind: 'list' };
    if (typeof items !== 'object' || items === null || Array.isArray(items)) {
      return unsupported("'items' must be a schema object");
    }
    const itemSchema = items as Record<string, unknown>;
    if (itemSchema['type'] === 'string') return { kind: 'list' };
    if (itemSchema['type'] === 'object') {
      const properties = itemSchema['properties'];
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        return unsupported(
          "an array of objects needs 'items.properties' to name the table columns",
        );
      }
      const columns: Record<string, ColumnType | ColumnSpec> = {};
      for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
        const type =
          typeof property === 'object' && property !== null
            ? (property as Record<string, unknown>)['type']
            : undefined;
        const column = columnTypeOf(type);
        if (!column) {
          return unsupported(
            `column '${name}' has type ${JSON.stringify(type)}; table columns must be string, number, integer or boolean`,
          );
        }
        const headers = headersOf(property as Record<string, unknown>);
        if (typeof headers === 'string') return unsupported(`column '${name}': ${headers}`);
        setOwn(columns, name, headers === undefined ? column : { type: column, headers });
      }
      if (Object.keys(columns).length === 0) {
        return unsupported("'items.properties' names no columns");
      }
      return { kind: 'table', columns };
    }
    return unsupported(
      `array items of type ${JSON.stringify(itemSchema['type'])} cannot be read from a page; use string or object`,
    );
  }

  if (s['type'] === undefined) {
    const entries = Object.entries(s);
    if (
      entries.length > 0 &&
      entries.every(([, v]) => v === 'string' || v === 'number' || v === 'boolean')
    ) {
      const columns: Record<string, ColumnType | ColumnSpec> = {};
      for (const [name, type] of entries) setOwn(columns, name, type as ColumnType);
      return { kind: 'table', columns };
    }
    return unsupported("schema has no 'type' and is not a column map");
  }

  return unsupported(`schema type ${JSON.stringify(s['type'])} cannot be read from a page`);
}

function columnTypeOf(type: unknown): ColumnType | undefined {
  if (type === 'string' || type === 'number' || type === 'boolean') return type;
  if (type === 'integer') return 'number';
  return undefined;
}

/**
 * Read a property's `x-header`: undefined when absent, the header list
 * when valid, or a reason string when it is malformed.
 */
function headersOf(property: Record<string, unknown>): string[] | undefined | string {
  if (!Object.prototype.hasOwnProperty.call(property, HEADER_KEYWORD)) return undefined;
  const raw = property[HEADER_KEYWORD];
  const list = typeof raw === 'string' ? [raw] : raw;
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((h) => typeof h === 'string' && h.trim() !== '')
  ) {
    return `'${HEADER_KEYWORD}' must be a non-empty string or a non-empty list of them`;
  }
  return list.map((h: string) => h.trim());
}

/** Assign as an own property, so a column called `__proto__` stays a column. */
function setOwn(
  target: Record<string, ColumnType | ColumnSpec>,
  key: string,
  value: ColumnType | ColumnSpec,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function unsupported(reason: string): ExtractPlan {
  return { kind: 'unsupported', reason };
}
