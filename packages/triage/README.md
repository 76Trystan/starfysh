# @sfysh/triage

Deterministic triage classifier for Starfysh. One pure function, `classify()`, maps a failed workflow run to a `FailureKind` with a short reason. The healer uses this to route failures. The hosted scheduler uses the same function so routing decisions are consistent across surfaces.

Triage lives in its own package rather than inside `@sfysh/runtime` so the classifier can stay surface-agnostic. Phase 2 extends the classifier with `contract_drift` and `deprecation` rules for the HTTP surface without touching the browser runtime.

## Usage

```ts
import { classify } from '@sfysh/triage';

const result = classify({
  error: thrown,
  step: workflow.steps.find((s) => s.id === thrown.stepId),
  postconditions: verifyReport.replays[0]?.postconditions,
});

if (result.kind === 'flake') retry();
else if (result.kind === 'auth') reauthenticate();
else if (result.kind === 'site') wakeHealer();
else escalate(result.reason);
```

## Classification rules

In priority order:

1. Any postcondition with `status: 'violated'` → `site`.
2. `VaultSecretMissingError` → `auth`.
3. `PostconditionViolation` → `site`.
4. `ExtractionError` → `site`.
5. `AssertionError` → `site`.
6. Response `status >= 500` → `flake` (Phase 2 HTTP surface).
7. Response `status === 401 || status === 403` → `auth`.
8. Error message matches `timeout`, `net::`, `econn*`, `500`, `502`, `503` → `flake`.
9. Otherwise → `unknown`.

Every rule returns a `reason` string so downstream consumers log it as-is.

## Status

Private workspace package. First npm publish is scheduled alongside `@sfysh/verifier` so both land in the same release window.
