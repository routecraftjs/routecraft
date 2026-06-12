---
"@routecraft/ai": patch
---

Forward the configured `baseURL` to the Anthropic and Gemini providers (previously only `apiKey` was passed, so ambient env vars like `ANTHROPIC_BASE_URL` silently won over plugin config), and validate `baseURL` for the keyed cloud providers.
