# @sfysh/verifier

## 0.1.0

### Minor Changes

- Initial public release. `@sfysh/verifier` replays a Starfysh workflow N times against a Page backend, evaluates pre- and postconditions through the shared runtime, checks output stability with per-field tolerance rules, captures timing envelopes, and produces human or JSON reports. Supports live replay against a live site and cassette replay for regression baselines; cassettes carry the same per-run secret redaction the runtime applies to error messages. Used by the Starfysh CLI's `compile verify` command.
