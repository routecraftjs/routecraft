---
"@routecraft/ai": minor
---

`agent()` and `llm()` stop reporting a model call that was cut off as an answer, and `llm()` stops sending the exchange body in place of an empty `user:`.

- A call the provider ends with finish reason `length` or `content-filter` with no text, tool call or structured output in its last step now fails with the new `AI1020`. Before, an agent returned empty text and its session read `replied`. That includes an agent turn cut off after its tools ran; the code is not retryable. A call cut off after writing something is unchanged.
- When `reasoning` is `'low'`, `'medium'` or `'high'` and `maxTokens` is not set, no output cap is sent and the provider's own maximum applies. Thinking tokens count against the cap, and the 1024 default was routinely spent on thinking alone. Calls without `reasoning`, or with `'none'`, still default to 1024. Set `maxTokens` to keep a cap.
- Behaviour change: an explicit `user:` on `llm()` that resolves to `""` or `[]` is sent as an empty prompt, as `agent()` already does. The body is used only when `user:` is not given.
