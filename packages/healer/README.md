# @sfysh/healer

Healer for Starfysh. When a workflow step fails and triage classifies the failure as a site change, the healer asks a model to re-derive that one step, validates the patch, verifies the patched workflow against the live site, and hands a reviewable diff to a person.

**Status: in progress.** The package is private and unpublished. The model input builder is implemented; `heal()` still throws `HealerNotImplementedError`, and nothing here calls a model yet.

## Model input

`buildHealPrompt()` is the only place a prompt is assembled. It takes the workflow, the failure, the page snapshot and the run's redaction function, and returns the messages for one heal attempt.

```ts
import { buildHealPrompt } from '@sfysh/healer';

const failed = report.replays.find((r) => r.status === 'failed');

const prompt = buildHealPrompt({
  workflow,
  failure: failed.error, // or RunResult.error from @sfysh/runtime
  snapshot: failed.snapshot,
  redact: ctx.redact,
  triage, // optional: the ClassifyResult from @sfysh/triage
});

prompt.messages; // [system, user], ready for a Provider
prompt.stepId; // the step the model is asked to replace
prompt.before; // that step as it is now
prompt.baseHash; // hash of the workflow the patch will be written against
```

What it guarantees about every prompt:

- **Redacted.** Every piece of variable text goes through `redact` before it is placed in a message.
- **Size-capped.** The snapshot is cut to 60,000 characters by default (`maxSnapshotChars`), the error message to 4,000. Cutting happens after redaction, so a secret cannot survive as a fragment at the cut. The model is told when the snapshot was cut.
- **Marked as data.** The workflow outline, the failed step, the failure and the snapshot each sit inside a block delimited by `<<<DATA name id>>>` and `<<<END name id>>>`. The id is random for each prompt and is checked to be absent from the data, so page content cannot close its own block. The system message is a constant with nothing interpolated into it.
- **Accessibility tree only.** A snapshot that is an HTML document is refused.
- **Narrow.** The model sees the failed step in full and an outline of the others (id, action, intent). It is asked for the replacement step only; the step id, base hash and operation on the final patch are filled in by the healer.

When a safe prompt cannot be built, `buildHealPrompt` throws `HealInputError` with one of these codes. Treat it as "escalate to a person", not as something to retry.

| Code                  | Meaning                                                         |
| --------------------- | --------------------------------------------------------------- |
| `no_step_id`          | The failure does not say which step failed.                     |
| `step_not_found`      | The failure names a step the workflow does not have.            |
| `empty_snapshot`      | The snapshot has no text to derive a selector from.             |
| `html_snapshot`       | The snapshot is an HTML document, not an accessibility tree.    |
| `delimiter_collision` | No block delimiter could be found that is absent from the data. |

Send the messages through a `RedactingProvider` from `@sfysh/providers` built with the same `redact`. The builder is the first layer of redaction; the provider wrapper is the second.

## What is still to come

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
