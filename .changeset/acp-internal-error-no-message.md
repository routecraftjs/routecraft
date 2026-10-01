---
"@routecraft/ai": patch
---

The ACP mount no longer sends a failure's message to the editor. A failed turn or a store outage on any request answered `-32603` with the error's message in `data`, which routinely names hosts, file paths and upstream responses. It now answers `-32603` carrying only the RC code (`{ "code": "RC5001" }`), or no `data` when the failure has none, and logs the full error at error level. The mount's own refusals (`-32002` for a session the caller cannot see, `-32602` for a request it cannot act on) and the SDK's parameter checks are unchanged. A `session/cancel` whose session lookup fails is now logged rather than printed to the console.
