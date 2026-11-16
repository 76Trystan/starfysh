# @sfysh/healer

Healer for Starfysh. When a workflow step fails and triage classifies the failure as a site change, the healer asks a model to re-derive that one step, validates the patch, verifies the patched workflow against the live site, and hands a reviewable diff to a person.

**Status: scaffold only.** The package is private and unpublished. `heal()` throws `HealerNotImplementedError`. Nothing here calls a model yet.

## What it will do

- Take a failed step with its attribution and an accessibility snapshot of the page at the point of failure.
- Send the model a redacted, size-capped snapshot marked as data. Raw HTML and secret values never leave the process.
- Parse the model's answer as a typed patch to a single step and validate it before anything runs.
- Verify the patched workflow with `@sfysh/verifier` and require human approval by default.

## How it fits with the other packages

| Package            | Role in a heal                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| `@sfysh/triage`    | Decides whether a failure reaches the healer at all.                   |
| `@sfysh/ir`        | Patch types, patch application, step validation and the workflow hash. |
| `@sfysh/providers` | The model call.                                                        |
| `@sfysh/verifier`  | Replays the patched workflow before a patch can be accepted.           |
| `@sfysh/runtime`   | Failure attribution, snapshots and secret redaction.                   |
