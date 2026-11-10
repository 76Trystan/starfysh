---
'@sfysh/runtime': minor
---

Add secret redaction (ADR 0013). `ctx.vault(name)` now returns a branded `Secret` string, resolved values register on the per-run context, and `ctx.redact(input)` replaces every registered value with `[REDACTED:<name>]`. `runner.run()` routes `error.message` through `ctx.redact` before attaching it to `RunResult.error`; the raw error remains available on `error.cause`. `Secret` is a phantom brand with zero runtime cost, so existing call sites that treat the return of `vault()` as a plain string continue to work.

Cassette-side scrubbing is a follow-up tracked alongside the Phase 2 recorder work because the recorder is constructed before the context exists.
