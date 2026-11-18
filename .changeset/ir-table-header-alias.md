---
'@sfysh/ir': minor
---

A table column in an `extract` schema can name the header text it appears under with the `x-header` keyword, a string or a list of strings:

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "sku": { "type": "string", "x-header": ["Stock code", "Item code"] },
      "qty": { "type": "integer" }
    }
  }
}
```

`planExtract` returns such a column as a `ColumnSpec` (`{ type, headers }`); a column without `x-header` is still its bare type, so plans for existing workflows are unchanged. A malformed `x-header` (empty, blank, or not strings) makes the plan `unsupported`. New exports: `ColumnSpec` and `HEADER_KEYWORD`. No IR schema change: the extract schema was already free-form JSON Schema.
