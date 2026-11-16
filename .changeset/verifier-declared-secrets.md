---
'@sfysh/verifier': minor
---

When no `vaultResolver` is passed, `replay()` now limits the default resolver to the names in the workflow's `secrets` list. A runner that asks for any other secret fails that replay with `VaultSecretNotAllowedError`. A workflow that passes validation already declares every secret it uses, so this only changes the result for a runner that reads a secret its workflow never declared. A resolver you supply yourself is used as it is.
