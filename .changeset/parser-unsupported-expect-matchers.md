---
'@sfysh/parser': minor
---

Dropped `expect()` assertions now surface in the `unsupported` list instead of vanishing silently. Any expect chain the condition extractor cannot translate (an unrecognised matcher like `toHaveCount`, a subject like `getByPlaceholder` that has no condition mapping, or an argument like a regex passed to `toHaveURL`) is reported with the matcher name as `method`, the 1-based source position, and the raw call text. Page-method and expect-matcher reports share the single `UnsupportedCall` list, so existing consumers need no shape changes. The package README has also been rewritten to describe the implemented parser rather than the pre-implementation scaffold.
