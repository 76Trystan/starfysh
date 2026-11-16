---
'@sfysh/runtime': minor
---

`EnvVaultResolver` now reads secrets from prefixed environment variables. `vault('portal_password')` reads `SFYSH_SECRET_PORTAL_PASSWORD`. Before this, it read `PORTAL_PASSWORD`, which meant a workflow definition could name any variable in the environment, such as `aws_secret_access_key`, and type it into a page.

Nothing breaks in this release. When the prefixed variable is not set, the resolver still reads the unprefixed one and emits a `DeprecationWarning` with the code `SFYSH_UNPREFIXED_SECRET`, once per secret name. That fallback will be removed in a later release, so rename your variables to `SFYSH_SECRET_<NAME>` when you see the warning.

Two new options:

- `new EnvVaultResolver({ prefix })` sets the prefix. Setting it, even to the default, turns the fallback off. Pass `prefix: ''` to keep reading unprefixed variables on purpose, with no warning.
- `new EnvVaultResolver({ allow })` limits the resolver to a list of secret names. Any other name throws the new `VaultSecretNotAllowedError`, which is separate from `VaultSecretMissingError` because it is not a missing credential.

`DEFAULT_SECRET_ENV_PREFIX`, `VaultSecretNotAllowedError` and the `EnvVaultResolverOptions` type are exported.
