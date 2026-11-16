# @sfysh/healer

Healer for Starfysh. When a workflow step fails and triage classifies the failure as a site change, the healer asks a model to re-derive that one step, validates the patch, verifies the patched workflow against the live site, and hands a reviewable diff to a person.

**Status: in progress.** The package is private and unpublished. Triage wiring, the model input builder and the output parser are implemented; `heal()` still throws `HealerNotImplementedError`, and nothing here calls a model yet.

## Triage before any model

Most failures should never reach a model. `triageFailure()` classifies a failed replay with `@sfysh/triage`, retries once when that is worth trying, and says where the failure goes.

```ts
import { triageFailure } from '@sfysh/healer';

const failed = report.replays.find((r) => r.status === 'failed');

const decision = await triageFailure(failed, {
  retry: () => runOnce(), // returns a ReplayOutcome; called at most once
});

if (decision.recovered) {
  // The retry passed. Nothing to heal.
} else {
  decision.route; // where it goes next
  decision.triage; // why
  decision.outcome; // the failure to work from (the retry, if one ran)
}
```

| Triage kind | Route                | What happens                                                    |
| ----------- | -------------------- | --------------------------------------------------------------- |
| `flake`     | `backoff`            | Retry later with backoff. No model.                             |
| `auth`      | `reauthenticate`     | Re-run the login sub-workflow. No model.                        |
| `site`      | `heal`               | The site changed. Build a prompt for the failed step.           |
| `task`      | `draft_for_approval` | The task changed. A draft is allowed; a person must approve it. |
| `unknown`   | `escalate`           | Nothing matched. Hand it to a person.                           |

**One retry, then route.** Triage marks every flake as retryable, and also a timeout waiting for an element, where one retry separates a slow page from a changed one. If the retry passes, `recovered` is true and the healer is not woken. If it fails, the second failure is classified and routed and is not retried again. The second failure is the one routed on because its snapshot is the fresher evidence.

**The page asking for a field is a task change.** `@sfysh/triage` classifies from the error alone. This package adds one rule that needs the page snapshot: a failure that would be `site`, on a page showing a validation message such as "Delivery phone is required", is reclassified as `task` with the rule code `page_requires_field`. A new selector cannot fix that, because the workflow has no value for the field. The rule is a narrow text match (a "* Required" legend does not trigger it) and it never applies to a flake, an auth failure or a failed extraction. When it matches by mistake, a healable failure goes to a person for approval, which is slower but safe.

`classifyOutcome(outcome)` gives the classification without the retry. It works best in the process that ran the replay, where the raw error is still attached; for an outcome read back from JSON it falls back to the redacted name and message.

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

## Model output

`parseHealResponse()` turns a model's completion into one of three results. It never throws.

```ts
import { parseHealResponse } from '@sfysh/healer';

const completion = await provider.complete(prompt.messages, { timeoutMs: 60_000 });
const result = parseHealResponse(completion, prompt);

if (result.status === 'patch') {
  result.patch; // a well-formed StepPatch: not yet policy-checked, not applied
} else if (result.status === 'cannot_heal') {
  result.rationale; // the model said the snapshot does not show a fix
} else {
  result.code; // why the answer was thrown away
}
```

The model supplies only the replacement step, a rationale and an optional confidence. The workflow id, base hash, step id, operation and `before` on the patch come from the prompt the healer built, and an answer that tries to set any of them is rejected. A patch is returned only after `validateStep` has passed on the new step and `validatePatch` on the assembled patch.

| Code            | Meaning                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `truncated`     | The output hit the token limit. Checked before parsing.                       |
| `refused`       | The model declined, or a safety filter cut the output.                        |
| `incomplete`    | Any other stop reason that does not mean the output is complete.              |
| `too_large`     | The answer is over 100,000 characters.                                        |
| `not_json`      | The answer is not a single JSON value. Prose around the JSON counts.          |
| `wrong_shape`   | The JSON is not one of the two answer forms, or has a key it must not have.   |
| `invalid_step`  | `after` is not a valid IR step. `errors` carries the schema errors.           |
| `invalid_patch` | The assembled patch is not valid, for example the replacement changed the id. |

One Markdown code fence around the whole answer is tolerated, because models add one even when told not to. Nothing else is: the parser does not search free text for something that looks like a patch. The rationale is model-written text that a reviewer will read in a terminal, so control characters are removed from it and it is cut to 2,000 characters.

A patch from this function is well formed, not approved. Limits on what a heal may change are a separate check that has not landed yet, and nothing in this package applies or runs a patch.

## What is still to come

- Check each patch against limits on what a heal may change before it is applied or run.
- Verify the patched workflow with `@sfysh/verifier` and require human approval by default.

## How it fits with the other packages

| Package            | Role in a heal                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| `@sfysh/triage`    | Decides whether a failure reaches the healer at all.                   |
| `@sfysh/ir`        | Patch types, patch application, step validation and the workflow hash. |
| `@sfysh/providers` | The model call.                                                        |
| `@sfysh/verifier`  | Replays the patched workflow before a patch can be accepted.           |
| `@sfysh/runtime`   | Failure attribution, snapshots and secret redaction.                   |
