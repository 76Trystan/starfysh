# @sfysh/healer

Healer for Starfysh. When a workflow step fails and triage classifies the failure as a site change, the healer asks a model to re-derive that one step, validates the patch, verifies the patched workflow against the live site, and hands a reviewable diff to a person.

**Status: in progress.** The package is private and unpublished, and no real model has answered its prompts yet. `heal()` runs the whole path: triage, the patch generators, the patch checks, live verification against known-good outputs, and an acceptance decision that waits for a person by default, all inside caps on attempts, tokens and heals per day. Nothing here writes a patched workflow anywhere; storing an accepted one is the caller's job. Each heal can be written to a local audit corpus (see [Recording every heal](#recording-every-heal)).

## Healing a failure

```ts
import { approvePatch, heal, MemoryHealHistory } from '@sfysh/healer';
import { AnthropicProvider } from '@sfysh/providers';

const result = await heal({
  workflow,
  outcome: failed, // a failed ReplayOutcome, with its page snapshot
  knownGood: { outputs: lastPassingRun.outputs },
  provider: new AnthropicProvider(),
  redact: ctx.redact,
  pageFactory: () => openFreshPage(), // live pages for verification
  history, // a HealHistory; MemoryHealHistory for one process
  retry: () => runOnce(), // optional, for triage's single retry
});

switch (result.status) {
  case 'recovered': // triage's retry passed
  case 'routed': // result.route: backoff, reauthenticate, draft_for_approval or escalate. No model.
  case 'no_evidence': // no snapshot, or no failed step named. No model.
  case 'capped': // result.cap: heals_per_day, attempts, tokens or budget (a MeteredProvider budget is spent)
  case 'not_healed': // every patch class was tried and none verified
  case 'decided': // result.decision is 'accepted' or 'awaiting_approval'
}

// Later, once a person has read the diff:
const approved = approvePatch({ decision: result.decision, current: workflow, reviewer: 'alex' });
```

In order, `heal()`:

1. triages the failure. Only a failure routed to `heal` goes further. A task change (`draft_for_approval`) is returned without a model call, because neither generator can add the missing input;
2. checks the daily cap for the workflow and records the run. Every run that gets this far counts, whatever its outcome;
3. tries new selectors, then an inserted step. A failure whose message says the element was covered ("intercepts pointer events") tries the inserted step first. Each class gets one model call, plus a retry of the same class after a transient provider error;
4. verifies each patch live and decides on it (below). The first patch that verifies ends the heal. One that fails verification moves on to the next class.

Every attempt, with its generator result, verification and decision, is on `result.attempts`, and `result.usage` sums the tokens.

### Limits

| Limit                       | Default | Counts                                                                       |
| --------------------------- | ------- | ---------------------------------------------------------------------------- |
| `maxAttemptsPerFailure`     | 3       | Model calls in one `heal()`. A class refused before any call does not count. |
| `maxTokensPerHeal`          | 20,000  | Input plus output tokens in one `heal()`.                                    |
| `maxHealsPerWorkflowPerDay` | 3       | `heal()` runs that reached the patch stage for one workflow in 24 hours.     |

Both per-heal caps are checked before every model call, and each call's output cap is lowered to what is left of the token budget. Input tokens are only known after a call, so one call can take a heal past its budget by the size of its prompt; no call starts once the budget is spent. The day is a rolling 24 hours, not a calendar day. `HealHistory` is a small interface (`count`, `record`, `patches`, `recordPatch`) so the daily count and the patch records below can live wherever run history already does. Two come with the package: `MemoryHealHistory` for one process, and `JsonlHealHistory` for a file (default `.compile/heal-history.jsonl`) that survives between processes, which is what `compile heal` uses. Its `prune()` drops run times older than 24 hours and keeps every patch record, since an oscillation can span weeks. It reads the file on every call and is meant for one process at a time.

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

The model supplies only a step, a rationale and an optional confidence: the whole replacement step under `after` for a selector heal, or the new step under `step` for an insert-step heal. The workflow id, base hash, step id, operation and `before` on the patch come from the prompt the healer built, and an answer that tries to set any of them is rejected. A patch is returned only after `validateStep` has passed on the new step and `validatePatch` on the assembled patch.

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

A patch from this function is well formed, not approved. Limits on what a heal may change are a separate check, described next, and nothing in this package applies or runs a patch.

## Generating a selector patch

`generateSelectorPatch()` is the one place in this package that calls a model. It takes a failure that triage routed to `heal` and returns a patch that has passed every check, or says why there is none.

```ts
import { generateSelectorPatch } from '@sfysh/healer';
import { AnthropicProvider } from '@sfysh/providers';

const result = await generateSelectorPatch({
  workflow,
  failure: decision.outcome.error,
  snapshot: decision.outcome.snapshot,
  redact: ctx.redact,
  provider: new AnthropicProvider(),
  triage: decision.triage,
});

switch (result.status) {
  case 'patch': // result.patch broke no rule, and result.score says how well grounded it is. Next: verify it.
  case 'needs_approval': // result.patch plus result.approvals. A person must confirm.
  case 'cannot_heal': // the model said new selectors will not fix it
  case 'rejected': // result.stage says where: input, response, candidates or policy
  case 'provider_error': // result.retryable says whether one more try is reasonable
}
```

In order, it:

1. builds the prompt with `buildHealPrompt()`. If a safe prompt cannot be built, or the step has no `target`, no call is made;
2. calls the provider through `RedactingProvider` from `@sfysh/providers`, so the whole request passes the redaction function a second time on its way out, with a timeout (60 seconds by default) and an output cap (2,000 tokens);
3. parses the answer with `parseHealResponse()`;
4. puts the candidates in preference order (role, testid, label, text, css), drops exact repeats, and refuses a `visual` candidate or more than five;
5. runs `checkPatch(patch, workflow, 'selector')`, described below.

One call is one attempt. There is no retry inside, so the caller decides whether a retryable `provider_error` or a malformed answer is worth another. Every result that got an answer back carries `call`, the model name and token usage, for cost tracking.

The function does not throw for anything the model, the provider or the page can cause. It does throw for a mistake in the arguments, such as a `redact` that does not return a string, and in that case no request is sent.

**Candidate order is fixed in code.** The prompt asks for role first, then testid, then css, and the generator sorts them anyway. Generated code uses the first candidate, so it should always be the most durable kind the model found. A `visual` candidate is refused because its value is a reference to a stored embedding, which a model cannot have.

Nothing here applies, runs or verifies the patch. A `patch` result is a proposal that broke no rule, and a `needs_approval` result must not be accepted on the strength of a passing verification alone.

## Generating an insert-step patch

Sometimes the failed step is still right and something new stands in its way: a consent dialog over the button, an extra "Continue" screen, a panel that takes longer to load. New selectors do not fix that. `generateInsertStepPatch()` asks the model for one new step to run immediately before the failed one.

```ts
import { generateInsertStepPatch } from '@sfysh/healer';

const result = await generateInsertStepPatch({ workflow, failure, snapshot, redact, provider });
```

It takes the same input as `generateSelectorPatch()`, returns the same result type and works the same way: one call through the redacting wrapper, with a timeout, then parse, order candidates and `checkPatch()`, this time for the `insert_step` class. What differs:

- **The model writes only the new step**, under `step` in its answer. It is told the step must be a `click` or a `wait` for a condition.
- **The healer chooses where the step goes and what it is called.** The patch is always an `insert_before` on the failed step, and the new step gets an id no step in the workflow uses (`healed_001`, or the next free number). An id the model writes is replaced.
- **The failed step does not need a target.** A `navigate` or an `assert` can have a step put in front of it.

Called directly, neither generator tries the other. `heal()` decides the order (see above).

An inserted `click` can still target any element on the page. The model is told not to click anything that submits, buys, deletes or confirms something the workflow did not already intend, but no code enforces that. This is why `decidePatch()` always holds an insert-step patch for a person.

## Confidence score

Every patch a generator returns carries a `score`. It is worked out in code from the page snapshot, not taken from the model. A model reports its confidence after reading a page that may have misled it, so that number can lower the score and never raise it.

```ts
import { scorePatch } from '@sfysh/healer';

const score = scorePatch({ patch, workflow, snapshot, patchClass: 'selector' });

score.score; // 0 to 1
score.level; // 'high' (0.8 and above), 'medium' (0.5 and above) or 'low'
score.signals; // [{ code, effect, detail }], everything that went into it
score.modelConfidence; // what the model reported, kept for the record
```

The generators call this for you and set `patch.confidence` to the score, so anything that reads the patch later sees the evidence-based number.

| Signal                         | Effect            | When                                                                                       |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------ |
| `base`                         | +0.5 or +0.3      | Starting value: 0.5 for new selectors, 0.3 for a new step.                                 |
| `first_candidate_unique`       | +0.3              | The first selector names exactly one element in the snapshot.                              |
| `first_candidate_ambiguous`    | +0.05             | It names more than one.                                                                    |
| `first_candidate_not_found`    | -0.3              | It names nothing in the snapshot.                                                          |
| `first_candidate_unverifiable` | 0                 | It is a css selector or a test id, which an accessibility tree cannot confirm.             |
| `first_candidate_kind`         | +0.1 to -0.1      | role +0.1, testid +0.05, label and text 0, css -0.1.                                       |
| `fallback_grounded`            | +0.05             | A later candidate names exactly one element.                                               |
| `fallback_not_found`           | -0.1              | A later candidate names nothing, so the model made it up.                                  |
| `same_role`                    | +0.05             | A selector heal kept the role of the old first candidate.                                  |
| `wait_text_found`              | +0.1              | The text an inserted wait looks for is in the snapshot.                                    |
| `snapshot_truncated`           | -0.1              | The snapshot was cut short. Not applied on top of a "not found".                           |
| `risky_click`                  | -0.4              | An inserted click names something that reads like a commitment (buy, delete, submit, pay). |
| `insert_step_cap`              | down to 0.6       | An insert-step patch cannot score above 0.6, so it is never `high`.                        |
| `model_less_confident`         | down to its value | The model reported less than the evidence gave.                                            |

A role selector is matched on its role and, when it has one, its accessible name as a case-insensitive substring, or as the whole name when the selector carries `[exact=true]` (as Playwright does). The prompt tells the model to add `[exact=true]` when a look-alike's name contains the intended one. Label and text selectors are matched against the snapshot text.

**What the score is not.** It is evidence that the selector points at something real, gathered before the patch has run. It says nothing about whether that element is the right one, which is what verification and a reviewer are for. The weights are starting values chosen by hand and have not been calibrated against real heals, and the commitment words are an English word list. The only thing that acts on the score is the opt-in automatic acceptance policy, which should stay off until the score has been calibrated.

## Patch scope

A well-formed patch can still do things a heal must not. `checkPatchScope()` compares the step before and after and rejects any change outside what one heal may touch. It trusts nothing the model said about the patch and does not apply it.

```ts
import { checkPatchScope } from '@sfysh/healer';

const scope = checkPatchScope(result.patch, workflow);
if (!scope.ok) {
  scope.violations; // [{ code, path, message }], every violation, not only the first
}
```

A replacement may change selector candidates, the intent, the timeout and the conditions of a guard or loop, and may add conditions. It is rejected when it does any of the following.

| Code                   | Rejected because                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `post_weakened`        | A `post` condition was removed or altered. An altered condition counts as a removed one.     |
| `assertion_changed`    | The condition of an `assert` step changed.                                                   |
| `nested_steps_changed` | The steps inside a guard or loop changed. One heal changes one step, not a subtree.          |
| `action_changed`       | The step became a different kind of step.                                                    |
| `outputs_changed`      | An `extract` changed its `bind` or `schema`, which decide what the workflow outputs.         |
| `parameters_changed`   | The step reads different workflow parameters than before.                                    |
| `unknown_field`        | The step gained a field its action does not have. The step schema alone does not catch this. |

An inserted step is rejected when it carries nested steps (`nested_steps_added`), is an `extract`, reads a workflow parameter, or has an unknown field.

Before any of that, the patch has to match the workflow: the right workflow id (`wrong_workflow`), the current hash (`stale_base`), an anchor step that exists (`unknown_step`), and a `before` equal to the step that is really there (`before_mismatch`). Without the last check, a patch could hide a dropped condition by leaving it out of both sides.

This is the general rule for every patch. The narrower limits for each kind of patch, the rules on URLs and secrets, and the limits on URL patterns are described in the next three sections.

## Allowlist by patch class

The scope check still lets a replacement reword the intent, add a condition or change a timeout. A heal that was asked for new selectors has no reason to do any of that. `checkPatchClass()` holds a patch to the kind of heal it was requested as.

```ts
import { checkPatchClass, checkPatchScope } from '@sfysh/healer';

const scope = checkPatchScope(patch, workflow);
const allowed = checkPatchClass(patch, workflow, 'selector');
if (!scope.ok || !allowed.ok) {
  // Reject the patch. Both results list every violation as { code, path, message }.
}
```

The class comes from the code that asked the model for the patch. It is never read from the model's answer.

| Class         | Operation                         | What the patch may do                                                                                          |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `selector`    | `replace`                         | Change `target.candidates` on a step that has a target. Every other field must equal the step in the workflow. |
| `insert_step` | `insert_before` or `insert_after` | Add one `click`, or one `wait` for a condition. Never a `fill`, a `navigate` or any other action.              |

| Code                 | Rejected because                                                            |
| -------------------- | --------------------------------------------------------------------------- |
| `wrong_op`           | The operation does not belong to the class.                                 |
| `unknown_step`       | The step the patch is anchored to is not in the workflow.                   |
| `no_target`          | A selector patch for a step with no target, such as a `navigate` or a loop. |
| `field_not_allowed`  | A selector patch changed, added or removed a field other than `target`.     |
| `no_change`          | A selector patch left the candidates as they were.                          |
| `action_not_allowed` | An inserted step is not a `click` or a `wait`.                              |
| `fixed_wait`         | An inserted wait pauses for a fixed time, or has no condition to wait for.  |
| `timeout_too_long`   | An inserted step sets a timeout above one minute.                           |

A selector patch is compared with the step in the workflow, not with the `before` the patch reports. An inserted `fill` is refused because it would put a value into a form the workflow's author never saw, and an inserted `navigate` because it would take the run somewhere else. This check narrows `checkPatchScope()` and does not replace it, so run both.

## Origins and secrets

Two things a heal must never do quietly: send the browser to a site the workflow has never visited, and change what happens to a secret. `checkPatchReach()` covers both.

```ts
import { checkPatchReach } from '@sfysh/healer';

const reach = checkPatchReach(patch, workflow);

if (reach.status === 'rejected') {
  reach.violations; // [{ code, path, message }]
} else if (reach.status === 'needs_approval') {
  reach.approvals; // a person must confirm each of these before the patch is accepted
}
```

Only `status: 'ok'` lets a patch go ahead on its own. The result has three states on purpose, so that code which checks for a pass cannot mistake "needs a person" for one.

| Code                | Outcome        | Why                                                                                                                                 |
| ------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `new_origin`        | Rejected       | A `navigate` URL, a `urlEquals` or an origin written into a `urlMatches` pattern names an origin the workflow does not already use. |
| `secret_added`      | Rejected       | The new step references a secret the old one did not. An inserted step may reference none.                                          |
| `secret_removed`    | Rejected       | A secret reference was replaced by something else.                                                                                  |
| `secret_changed`    | Rejected       | A reference now points at a different secret.                                                                                       |
| `unknown_step`      | Rejected       | The step being replaced is not in the workflow.                                                                                     |
| `secret_retargeted` | Needs approval | The step types a secret and the patch changes which element it is typed into.                                                       |

**Origins.** An origin is scheme, host and port, so `http` in place of `https`, a subdomain and another port are all new. The known set is every origin already in the workflow. A relative URL passes because it stays where the run already is. A `javascript:`, `data:` or `file:` URL, a protocol-relative `//host` and a URL that does not parse are all treated as new origins. A workflow whose only URL is a parameter has no known origin, so a patch can add no literal URL to it.

**Secrets.** A renamed password field is the commonest reason to heal a login step, and "type the password into the search box" looks the same to code. That is why a new target on a step with a `{secret}` value is neither rejected nor accepted: it goes to a person.

**Known limit.** A `urlMatches` pattern that names a host without a scheme (`evil\.test/login`) reads the same as a path and is not caught. Such a condition can only be added alongside the existing ones, because the scope check does not let a `post` condition be replaced.

## URL patterns

A `urlMatches` condition is compiled into a regular expression and run against the page URL, which the site controls. A pattern such as `(a+)+$` is valid and can hold the event loop for minutes. `checkPatchPatterns()` puts limits on every pattern a patch introduces.

```ts
import { checkPatchPatterns } from '@sfysh/healer';

const patterns = checkPatchPatterns(patch, workflow);
if (!patterns.ok) {
  patterns.violations; // [{ code, path, message }]
}
```

| Code                           | Rejected because                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `pattern_too_long`             | The pattern is longer than 200 characters.                                                   |
| `pattern_invalid`              | The pattern is not a valid regular expression. Generated code would throw on it.             |
| `pattern_nested_quantifier`    | A group that can repeat contains something of variable length, as in `(a+)+` or `(.*a){20}`. |
| `pattern_too_many_quantifiers` | The pattern has more than three unbounded quantifiers (`*`, `+`, `{n,}`), as in `.*.*.*.*x`. |

A pattern that is already in the workflow, character for character, is not checked. A person wrote it, and refusing it would make any step that carries one impossible to heal. Edit it at all and it counts as new.

The nested-quantifier rule looks at the shape of the pattern and refuses when unsure, so some harmless patterns fail it (`(/\d+)*` is one). It does not catch a repeated alternation whose branches overlap, such as `(a|a)*`. `checkUrlPattern(pattern)` runs the same limits on one string.

## Running every check

The four checks above are separate functions so each has its own codes and tests. `checkPatch()` runs all of them, and code that decides whether a patch may go ahead should call it instead of the four.

```ts
import { checkPatch } from '@sfysh/healer';

const verdict = checkPatch(patch, workflow, 'selector');

if (verdict.status === 'rejected') {
  verdict.violations; // [{ check, code, path, message }] from every check that objected
} else if (verdict.status === 'needs_approval') {
  verdict.approvals;
}
```

All four always run, so a rejected patch comes back with everything that is wrong with it, and `check` names the one each violation came from (`scope`, `class`, `reach` or `pattern`). A violation from any check rejects the patch even when another only asked for approval. Only `status: 'ok'` lets a patch go ahead on its own.

## Verifying and accepting a patch

A patch that passed every check is still a proposal. `heal()` runs these for you; they are exported for callers that drive the generators themselves.

```ts
import { approvePatch, decidePatch, verifyPatch } from '@sfysh/healer';

const verification = await verifyPatch({
  workflow,
  patch: result.patch,
  knownGood: { outputs: lastPassingRun.outputs },
  pageFactory: () => openFreshPage(),
});
const decision = decidePatch({
  workflow,
  patchClass: 'selector',
  score: result.score,
  verification,
});
```

**Verification.** `verifyPatch()` applies the patch and replays the patched workflow live, at least three times. It passes only if every run passes, the runs agree with each other, and every run's outputs match the outputs of the last run that worked. Agreement between runs is not enough on its own: a patch that reads the wrong column reads it the same way every time. With the default runner (the IR interpreter, with the patched or inserted step on its first candidate only and every other step falling through its candidates as in production) it also fails any run in which the patched or inserted step did not run, so a patch inside a guard that was never taken cannot pass trivially.

**Partial heals.** A site change can break several steps at once, and then a correct patch for the first can never pass: the next broken step still fails. `verifyPatch()` returns `progressed` instead of `failed` when every run passed the patched step (and, for an inserted step, the step it was inserted before), then failed at one and the same later step, and the outputs emitted so far agree with each other and match the start of the known-good outputs. `failedStepId` names the next broken step and `outputsMatched` says how much of the known-good output was reproduced. `decidePatch()` always holds a progressed patch for a person, under every policy, with the reason `partial_heal`; once it is approved, the next run fails at the next step and the next heal picks up from there. Several heals on the same step with no visible change between them (a banner, then a menu, then a rename, all in front of one link) do not count as progress, because nothing in the runs tells that apart from a click that did nothing. Secrets come from `SFYSH_SECRET_` variables for the workflow's declared secrets only.

| Failure                | Meaning                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `run_failed`           | A run threw or violated a terminal postcondition.          |
| `unstable`             | The runs produced different outputs.                       |
| `output_mismatch`      | A run's outputs differ from the known-good outputs.        |
| `patched_step_not_run` | A run passed without the patched step running and passing. |

Never verify against a cassette: it replays what the old site returned, so it says nothing about a patch.

**Possible false heals.** Matching the last run exactly has a hole: a field the tolerance map exempts can change completely and still match, so a patch that starts reading the wrong column passes if that column is tolerated. Pass `knownGood.history`, the outputs of the last passing runs (oldest first, at most ten are used), and every verification run is also checked against what those runs had in common, with `checkEnvelope` from `@sfysh/verifier`. Per field, with array positions folded together so every table row counts, it checks:

- the JSON types seen;
- whether the field is always present;
- a band of array lengths;
- a numeric range;
- the form of each string (letters, digits and punctuation, so an order number does not turn into a product name).

Tolerance exempts a field from the range check only. A tolerated field may move, but it may not turn into a different kind of thing. A patch outside the envelope still verifies, and is recorded as `envelope: { status: 'outside', deviations }` on the verification. `decidePatch` then holds it for a person with the reason `possibly_false_heal`, under every policy. Messages name fields, never values. With fewer than three history runs the check is skipped and reported as `insufficient_history`. It cannot catch a wrong element that produces values of the same kind as the right one.

**Decision.** `decidePatch()` runs `checkPatch()` again itself, then returns `rejected`, `awaiting_approval` with every reason, or `accepted`. The default policy, `{ mode: 'human' }`, holds every patch for a person. `{ mode: 'auto', minScore }` (with `minScore` at least 0.8) accepts a verified selector patch without review, but still holds an insert-step patch, a partial heal, one the checks flagged for approval, one scoring below `minScore`, one whose step run was not confirmed, one flagged as a possible false heal, and one that undoes an earlier heal. `{ mode: 'auto_promotion' }` accepts only a verified `promotion` (below) and treats every other class as `human` does; reversions, flagged approvals and unconfirmed step runs still hold a promotion for a person.

**Approval.** `approvePatch()` is the only way a held patch becomes accepted. It records the reviewer and the time, and refuses if the workflow has changed since the patch was verified.

## Promoting a working fallback

A run that passes on a fallback selector candidate is green, but its primary selector is broken (`ReplayOutcome.degraded`). The IR already holds the fix, so no model is needed: `promote()` moves the candidate that worked to the front of its step, verifies the result like any other patch (live runs, primary candidate only, against the known-good outputs), checks it against earlier heals, and decides on it.

```ts
import { promote, promotionRecord } from '@sfysh/healer';

const result = await promote({
  workflow,
  degraded: outcome.degraded ?? [],
  knownGood: { outputs: outcome.outputs },
  pageFactory: () => openFreshPage(),
  history,
  policy: { mode: 'human' }, // or { mode: 'auto_promotion' }
});
// result.status: 'none' | 'not_promoted' | 'decided'
if (result.status !== 'none')
  await corpus.write(promotionRecord({ workflow, knownGood, result, redact }));
```

- The patch class is `promotion`. Its allowlist rule is stricter than a selector patch's: the new candidate list must be a reordering of the old one, with nothing added, removed or edited.
- One step per promotion. Other degraded steps are returned as `remaining`, for a later run once this one is applied. A step that degraded onto different candidates in one run (a loop over items) is skipped as `inconsistent`.
- Every promotion carries a fixed score of 0.9 with the single signal `worked_live`; there is no snapshot to ground it in, and the evidence is the live success plus verification.
- Promotions do not count against the daily heal cap, which bounds model spend. The reversion check does apply, so a site that flips between two designs does not have its candidates swapped back and forth.
- In the corpus a promotion is a heal record with `trigger: 'degraded'`, no triage, and no tokens.

## Heals that undo earlier heals

A site that flips between two designs (an A/B test, a staged rollout, a rollback) would otherwise have the healer switch the workflow back and forth, each heal verifying and each one costing a model call and a review. `heal()` records every heal that reaches a decision, with the state it started from, and checks each verified patch against those records with `findReversions()`.

| Code                 | The patch...                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `workflow_revisited` | produces a workflow identical to one an earlier heal started from. |
| `step_reverted`      | puts the step back to the exact version an earlier heal replaced.  |
| `selector_reverted`  | puts back the first selector an earlier heal moved away from.      |

A reversion is not a rejection: the site may really have gone back, and the patch may be right. It holds the patch for a person under any policy, with the reason `reverts_earlier_heal`, so a reviewer sees that the site looks unstable. A heal that was held and never approved still counts as a state the workflow was in, because it records where the heal started, not where it went. Proposing the same rejected patch again is not a reversion.

Keep patch records for as long as the workflow exists. An oscillation can span weeks.

## Reviewing a patch

`renderReview()` turns a decision into the text a reviewer reads. `semanticDiff()` and `renderSemanticDiff()` give the diff part on its own.

```ts
import { renderReview, semanticDiff } from '@sfysh/healer';

if (result.status === 'decided') {
  console.log(renderReview(result.decision, { workflow }));
}

semanticDiff(patch, workflow); // the same diff as data, for JSON output
```

A review shows, in this order: what was decided and every reason a person is needed; what the patch changes; the evidence (live runs, timing, and the confidence score with each signal); and last, the model's own explanation, marked as unverified.

```
Heal of workflow wf_orders, step click_002: waiting for approval.

Why a person must look:
  - Every patch is reviewed by a person under the current policy.

Step click_002 ("Open the orders page."):
  Selectors reordered. Now tried first: css "nav a.orders" (was #2).
    Before, the first choice was role "link[name='Orders']".
    1. css "nav a.orders" (was #2)
    2. role "link[name='Orders']" (was #1)

Verification: 3 of 3 live runs passed, and every run's outputs matched the last known-good run.
...
```

**Selector lists are read as lists.** The field-level diff in `@sfysh/ir` compares arrays position by position, so promoting the second candidate shows as a change at every index. The semantic diff says what happened instead:

| Kind                | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `reordered`         | The same candidates in a different order.                             |
| `inserted_at_front` | New candidates in front; the old ones follow, unchanged and in order. |
| `changed`           | Anything else. Removed candidates are listed.                         |

Every candidate change names the selector compiled code will now try first, and where it came from, because that is the one that decides whether the workflow runs. Other fields are listed one by one with readable paths (`post[1].urlMatches`). An inserted step is described by its action, intent, target and fallbacks.

**Untrusted text.** Selector values, intents and the rationale were written by a model that read a web page. Every value is printed on one line with control characters, escape sequences and Unicode line separators replaced by a space, and cut to 200 characters (2,000 for the rationale), so nothing in a patch can recolour the terminal, clear it, or forge a line such as "Approved: yes".

## Recording every heal

Every heal should be written down, whatever its outcome. `healRecord()` turns a heal's input and result into one plain JSON record, and `JsonlCorpus` appends it to `.compile/corpus/heals.jsonl`.

```ts
import { heal, healRecord, JsonlCorpus, reviewRecord } from '@sfysh/healer';

const corpus = new JsonlCorpus(); // or new JsonlCorpus({ dir })
const result = await heal(input);
const record = healRecord({
  workflow: input.workflow,
  knownGood: input.knownGood,
  policy: input.policy,
  result,
  redact: input.redact,
});
await corpus.write(record);

// Later, when a person answers a held heal:
await corpus.write(reviewRecord({ heal: record, verdict: 'approved', reviewer: 'dana' }));
```

A heal record holds the workflow hash, the failure, the triage decision, the policy, and for each model call: the model that answered, a hash of the prompt, token usage, the patch, its confidence score with every signal, the verification result (runs, timings, a hash of each run's outputs, failure codes and the paths that drifted) and the decision. That is enough to audit a heal, and to compare scores against outcomes before any score threshold is trusted.

**What is never written.** The page snapshot and the workflow's outputs are page content, so the record keeps their SHA-256 instead. Equal hashes still show that two heals saw the same page, or that a patched run produced the known-good data. Drift values are left out for the same reason; only the field paths are kept. Pass `includeOutputs: true` to keep the known-good outputs as well. Every string value in a record goes through `redact` before it is returned, as a backstop for anything that slipped past the IR rules.

**Reviews are separate records.** A person may answer hours after the heal ran and the file is only ever appended to, so `reviewRecord()` writes a second record that points at the heal by id. A review must name the reviewer.

**Shadow mode.** Model-written patches always wait for a person, but every verified one is also decided a second time under the candidate automatic rule (`SHADOW_AUTO_POLICY`: a selector patch, no approval reasons, score at least 0.8). The result is on `HealAttempt.shadow` and in the corpus as `wouldAutoAccept: { policy, eligible, reasons }`. Set against the reviewer's verdict, it shows how often the automatic rule agrees with people on your own workflows, which is the evidence needed before model-written patches are ever accepted without review. `heal({ shadowPolicy })` tests a different rule. The verdict never changes the real decision, and `renderReview()` never shows it: a reviewer told the machine would have accepted a patch is nudged to accept it, and the agreement rate would then measure the nudge. Keep it out of anything a reviewer reads before deciding, including JSON passed to an agent that presents the review.

**Reading it back.** `readCorpus(dir)` returns every record in the order written. A line that is not valid JSON, or is a record of another version or kind, is skipped and listed in `problems` instead of thrown, so a line cut off by a crash does not hide the rest. A missing corpus reads as empty. `MemoryCorpus` keeps records in memory for tests and benchmark runs.

Use one writer per corpus directory. Two processes appending at once can interleave long lines.

## Labels and the report

A review says whether a person accepted a patch. Whether the patch was right is a separate fact, often learnt later, recorded with `labelRecord()`: verdict `correct`, `false_heal` or `unknown`, from `benchmark` (the synthetic-drift harness's known answer), `reviewer` (a person, who must be named) or `post_accept_watch`. The latest label for a heal wins.

`corpusReport(records)` turns a corpus into numbers, overall, by patch class and by workflow, and `renderReport()` prints them. The definitions are fixed in one place (`report.ts`):

- **False-heal rate** = heals labelled `false_heal` / verified heals labelled `correct` or `false_heal`. Unlabelled heals are counted, never assumed correct, and the rate is `null` when nothing is labelled. `appliedFalseHeals` counts the ones that reached the workflow.
- **Shadow agreement** = for verified model-written heals with a shadow verdict and a human answer, the share where they agreed. A rejection, a revert or a `false_heal` label is a no; an approval with none of those after it is a yes. `acceptedButRejected` is the cell that decides whether automatic acceptance of model patches is ever safe.
- **Score bands** (below 0.5, 0.5 to 0.8, 0.8 and above) with each band's approvals, rejections, reverts and labels, for calibrating the confidence score.

Reviews and labels whose heal is not in the corpus are counted as `orphans`.

## What is still to come

- A first run against a real model.
- Automatic acceptance of model-written patches, once the benchmark has calibrated the score. Only promotions can be accepted automatically today.
- Measuring the false-heal rate on the synthetic-drift benchmark, which decides whether automatic acceptance is ever switched on.

To run the healer from the command line, use `compile heal` in `@sfysh/cli`. It keeps the history, the corpus and the known-good outputs on disk.

## How it fits with the other packages

| Package            | Role in a heal                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| `@sfysh/triage`    | Decides whether a failure reaches the healer at all.                   |
| `@sfysh/ir`        | Patch types, patch application, step validation and the workflow hash. |
| `@sfysh/providers` | The model call.                                                        |
| `@sfysh/verifier`  | Replays the patched workflow before a patch can be accepted.           |
| `@sfysh/runtime`   | Failure attribution, snapshots and secret redaction.                   |
