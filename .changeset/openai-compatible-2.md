---
"@routecraft/ai": minor
---

The optional `@ai-sdk/openai-compatible` peer now requires `^2.0.0`, the line that matches `ai` 6 and the other providers. Every 1.x release depends on `undici` 5, which carries TLS validation and WebSocket denial-of-service advisories with no fix on that line. A project using the LM Studio or another OpenAI-compatible provider upgrades with `bun add @ai-sdk/openai-compatible@^2`.
