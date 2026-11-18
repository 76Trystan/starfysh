---
'@sfysh/runtime': minor
---

`emit.table` (and `extractTable`) now match columns to header cells more forgivingly, and a column can name the header text it appears under.

- A column still matches a header with exactly its name first. When none does, it matches a header that differs only in case, spacing (non-breaking spaces included) or Unicode compatibility form, so `sku` reads a column headed `SKU`.
- A column can be a `ColumnSpec`, `{ type, headers }`, listing other header text to try: `{ sku: { type: 'string', headers: ['Stock code'] } }`. Aliases are matched the same way, exact first.
- If two header cells match one column at the same step, extraction fails with an `ExtractionError` naming both, instead of picking one. A guessed column is a wrong-column read.
- New exports: `ColumnSpec`, `ColumnType` and `normaliseHeader`.

Workflows whose headers matched exactly before read the same columns as before.
