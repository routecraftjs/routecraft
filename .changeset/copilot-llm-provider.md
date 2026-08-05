---
"@routecraft/ai": minor
---

Add a first-class `copilot` LLM provider backed by the GitHub Copilot CLI via `@nomomon/ai-sdk-provider-github-copilot` (new optional peer). Routes use `llm("copilot:gpt-5")` after registering `providers.copilot` in `llmPlugin`.

Tool executions that need approval are denied unless the route opts in: pass `onPermissionRequest` for a real allow/deny policy (the request carries a `kind` of `shell`, `write`, `mcp`, `read`, or `url`), or `approveAllTools: true` to approve everything in a trusted sandbox. Note that provider release 0.2.0 accepts the handler and silently drops it, so both take effect only on a release that forwards it to the Copilot SDK.

`cliPath`, `cliUrl`, and `githubToken` configure the underlying CopilotClient, and one client is cached per distinct client config so a dispatch does not spawn a CLI process per call. `llmPlugin` now has a teardown that stops those clients on context shutdown, exported as `disposeCopilotProviderCache()` for anyone registering providers without the plugin. Provider limitations inherited from the CLI: no structured output, no embeddings, and sampling options are ignored.
