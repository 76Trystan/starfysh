---
'@sfysh/verifier': minor
---

New `primaryOnly` interpreter option: a list of step ids that use their primary selector candidate only, whatever `candidates` says. Every other step keeps falling through its candidates as in production.

This lets a healer prove that a patched step's first choice works without holding the rest of the workflow to its primaries. Before, verifying a patch on a page where several steps had degraded at once failed every time, because the other degraded steps were refused their working fallbacks.
