---
"@routecraft/ai": minor
---

`acp:` on `defineConfig`, the first-party way to serve the Agent Client Protocol, beside `mcp:`.

`defineConfig({ servers: { default: { port } }, acp: { auth } })` boots and serves the protocol with the agents `craft start` discovered or the ones written under `agent:`, in any key order: config keys apply in a fixed registration order with `acp` last, before anything in `plugins`. The key takes exactly the options `acpPlugin()` takes (`path`, `server`, `auth`, `agent`, `cors`, `agentInfo`, `toolCallPayloads`), none required. `plugins: [acpPlugin()]` keeps working with its documented ordering constraint; the empty-registry refusal now names both forms. The configuration reference documents `acp` beside `mcp`.
