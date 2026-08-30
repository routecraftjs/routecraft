---
"@routecraft/ai": minor
---

`llm()` and `agent()` can ask for a reasoning effort, and reach a provider
directly.

Reasoning effort is the main cost and latency dial on a current model and it is
per call, not per deployment: a narrow classifier and a hard agent turn want
opposite settings against the same model id. Nothing in `LlmOptions` reached it,
and there was no passthrough to reach it with either.

Two shapes ship together. `reasoning: "none" | "low" | "medium" | "high"` is the
portable one, mapped to each provider's own control (`reasoningEffort` on
OpenAI, `effort` and `thinking` on Anthropic, `thinkingConfig.thinkingLevel` on
Gemini, `reasoning.effort` on OpenRouter, `think` on Ollama). A level a provider
cannot express maps to the nearest one it supports rather than throwing, since
an option that refuses on some providers is not portable; the mapping table is
documented, including where it is lossy, and Gemini's inability to turn thinking
off is stated rather than implied.

`providerOptions` is the labelled escape hatch, forwarded to the SDK verbatim
for what the normalised form cannot say (Anthropic's thinking token budget,
Gemini's `thinkingBudget`). The two merge per provider namespace and per setting
within it, and the authored value wins for the settings it names.

`AgentOptions` gains the same sampling block as `LlmOptions` (`temperature`,
`maxTokens`, `topP`, both penalties, `reasoning`, `providerOptions`), and
`agentPlugin({ defaultOptions })` can set it for every agent in a context. The
agent had no sampling surface at all: its model call was built from two
constants, so an agent could not ask for a different temperature either. The
defaults are the values it hardcoded, so an agent that declares none behaves
exactly as before.

Both paths from an authored option to the provider call used to copy the
sampling block field by field, which is why an option could typecheck and reach
nothing. They now carry the whole block, and the list of keys they walk is
exhaustive by construction: adding an option to the block without listing it
fails to compile.

Also fixed while building the agent path: a second `agentPlugin` install's
`defaultOptions` silently dropped every field except `model`, `tools` and
`blocks`, so a `maxTurns` or `principal` set by a later install never applied.
Every single-valued default now either applies or throws on conflict, which is
what the function already documented.
