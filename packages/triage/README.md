# @sfysh/triage

Deterministic triage classifier for Starfysh. One pure function, `classify()`, takes a failed workflow run and says where it should go next: retry, re-authenticate, wake the healer, or escalate to a person. No I/O and no model call. The healer uses it to route failures, and a scheduler can use the same function so routing is consistent everywhere.

Triage lives in its own package, not inside `@sfysh/runtime`, so the classifier can stay surface-agnostic. Phase 2 extends it with `contract_drift` and `deprecation` rules for the HTTP surface without touching the browser runtime.

## Usage

Pass the raw error and, when you have it, the attribution from the failed run. `RunResult.error` from `@sfysh/runtime` and `ReplayOutcome.error` from `@sfysh/verifier` both carry the raw error as `cause` and can be passed as the attribution as they are.

```ts
import { classify } from '@sfysh/triage';

const failed = report.replays.find((r) => r.status === 'failed');
const result = classify({
  error: failed.error.cause,
  attribution: failed.error,
  postconditions: failed.postconditions,
});

if (result.retryable && attempts === 0) retryOnce();
else if (result.kind === 'flake') retryWithBackoff();
else if (result.kind === 'auth') reauthenticate();
else if (result.kind === 'site') wakeHealer(result.stepId, result.selector);
else if (result.kind === 'task') draftForHumanApproval(result.stepId);
else escalate(result.reason);
```

## The result

| Field                          | Meaning                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                         | `flake`, `auth`, `site`, `task` or `unknown`.                                                                                                                                         |
| `rule`                         | Stable code for the rule that fired. Branch and aggregate on this, not on `reason`.                                                                                                   |
| `reason`                       | Short description for logs.                                                                                                                                                           |
| `retryable`                    | Whether a plain retry is worth trying first. True for every `flake`, and for a `site` failure caused by a selector timeout, where one retry separates a slow page from a changed one. |
| `stepId`, `action`, `selector` | The IR step that failed and the selector it was using, when known.                                                                                                                    |
| `phase`, `condition`           | Set when a pre or post condition was violated.                                                                                                                                        |

Attribution fields come from whichever source has them, in this order: the `attribution` you pass, a `StepFailure` wrapper around the error, a `PostconditionViolation`, then the IR `step` you pass. Fields that are not known are left off; nothing is invented.

## Classification rules

The first rule that matches wins.

| #   | Signal                                                                                                                                           | `kind`            | `rule`                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------ |
| 1   | A postcondition you passed has `status: 'violated'`                                                                                              | `site`            | `postcondition_violated` |
| 2   | `VaultSecretMissingError`                                                                                                                        | `auth`            | `vault_secret_missing`   |
| 3   | `PostconditionViolation`                                                                                                                         | `site`            | `condition_violated`     |
| 4   | `ExtractionError`                                                                                                                                | `site`            | `extraction_failed`      |
| 5   | `AssertionError`                                                                                                                                 | `site`            | `assertion_failed`       |
| 6   | Response status 400 or 422, and the message says a field is required or missing                                                                  | `task`            | `required_field_missing` |
| 7   | Response status 500 or above                                                                                                                     | `flake`           | `http_server_error`      |
| 8   | Response status 401 or 403                                                                                                                       | `auth`            | `http_auth`              |
| 9   | Network-level error in the message (`net::ERR_`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `socket hang up`) | `flake`           | `network_error`          |
| 10  | A 5xx status quoted in the message next to a word that makes it a status code (`status code 503`, `HTTP 502`, `502 Bad Gateway`, `received 500`) | `flake`           | `http_server_error`      |
| 11  | Timeout while waiting for an element                                                                                                             | `site`, retryable | `selector_timeout`       |
| 12  | Any other timeout (navigation, a run or step time limit)                                                                                         | `flake`           | `timeout`                |
| 13  | Nothing matched                                                                                                                                  | `unknown`         | `no_rule`                |

Two points about the message rules.

**A timeout is not always a flake.** A page that is slow to load is transient. An element that never appears on a page that did load is what a changed selector looks like, and treating it as a flake would retry it indefinitely without the healer ever seeing it. Rule 11 applies when the attribution says the failing step was a `click`, `fill` or `extract` with a selector. With no attribution at all, it falls back to the wording of the backend's message (`waiting for locator(...)`, `locator.click: Timeout`). Attribution wins when both are present.

**A number in a message is not a status code.** `Expected 500 rows` and `Price 502.00` do not match rule 10. The number has to sit beside a word that makes it an HTTP status.

`task` has one rule today, and it only fires with a `response`, which browser failures do not have. For the browser surface, deciding that a failure is a task change (the site now demands something the workflow has no answer for) is left to the healer, which can see the page snapshot. The kind is in the union now so consumers can handle it from the start.

## Status

Private workspace package. It stays unpublished until the healer lands, so the result shape can settle against a real consumer.
