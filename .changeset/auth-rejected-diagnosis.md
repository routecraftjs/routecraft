---
"@routecraft/routecraft": minor
"@routecraft/ai": patch
---

`auth:rejected` says why a token was refused. A bad signature, a wrong issuer and a wrong audience all arrived as `reason: "invalid_token"` with nothing to tell them apart, in the event and in the log alike, because the verifier's error was dropped before either was written. A rejection whose verifier error came from `jose` (what `jwks()` uses) now carries `code`, the library's error code such as `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, and `claim`, the name of the claim that failed (`aud`, `iss`), and is logged at `debug` with the error's type, code and message under `err`. The MCP and ACP mounts add `code` and `claim` to their own rejection log line. `reason` keeps its closed vocabulary. Both fields come from closed lists, so a custom validator's message or code never reaches an event or a log binding, and no claim value is ever emitted. `diagnoseRejection` is exported for a mount that reports rejections itself.
