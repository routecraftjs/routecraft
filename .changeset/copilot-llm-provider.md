---
"@routecraft/ai": minor
---

Add a first-class `copilot` LLM provider backed by the GitHub Copilot CLI via `@nomomon/ai-sdk-provider-github-copilot` (new optional peer). Routes use `llm("copilot:gpt-5")` after registering `providers.copilot` in `llmPlugin`. Copilot tool executions require approval; the provider defaults to approving everything so non-interactive routes never hang on a pending permission request, and accepts an `onPermissionRequest` handler for a real allow/deny policy. `cliPath`, `cliUrl`, and `githubToken` configure the underlying CopilotClient (one client, and one CLI process, is cached per distinct client config). Provider limitations inherited from the CLI: no structured output, no embeddings, and sampling options are ignored.
