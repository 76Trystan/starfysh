---
'@sfysh/runtime': patch
---

Failure messages no longer carry terminal colour codes. `describeFailure` now strips ANSI escape sequences (colours, cursor movement and hyperlinks) from the error message and from a violated condition's `reason` before redacting them, so `RunResult.error.message` and the verifier's `ReplayOutcome.error.message` are plain text. Playwright colours parts of its error messages even when the output is not a terminal, and those codes were showing up in logs and JSON reports.

Stripping happens before redaction. An escape sequence in the middle of a quoted value could otherwise split a registered secret so the redactor did not match it. The raw error on `cause` is unchanged.
