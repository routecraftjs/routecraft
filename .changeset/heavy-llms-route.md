---
"@routecraft/ai": patch
---

Forward a configured `baseURL` to the Anthropic and Gemini LLM providers (previously only OpenAI honoured it, so explicit config lost to the ambient `ANTHROPIC_BASE_URL` environment variable), and load the `yaml` front-matter parser for `agents()` / `skills()` through `loadOptionalPeer` so a missing package surfaces as RC5017 with an install hint instead of a misleading front-matter parse error.
