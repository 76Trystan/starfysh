---
'@sfysh/ir': minor
---

`parseRoleSelector` reads unquoted attribute values and reports what it cannot read. `heading[level=2]` gives `{ level: 2 }`, `button[exact=true]` gives `{ exact: true }`, and `button[name=Submit]` gives `{ name: 'Submit' }`; `name` and `description` are always text. Before, unquoted values were dropped silently. The result has a new `unparsed` array listing any part that is not an `attribute=value` pair, including a whole value that does not fit the format, so callers can refuse instead of guessing. Option values are now `string | number | boolean`. A name containing a line break is now read.
