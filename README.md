<div align="center">

  <img src="./routecraft.svg" alt="Routecraft" width="120" />

  <p><strong>Tools for agents. Or the agent harness itself.</strong></p>

  <a href="https://github.com/routecraftjs/routecraft/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/routecraftjs/routecraft/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.1%2B-fbf0df?logo=bun">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%2B-3c873a?logo=node.js">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9%2B-3178c6?logo=typescript">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue"></a>
  <a href="https://github.com/routecraftjs/routecraft/issues"><img alt="Issues" src="https://img.shields.io/github/issues/routecraftjs/routecraft"></a>
  <a href="https://github.com/routecraftjs/routecraft/pulls"><img alt="PRs" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>

</div>

## About

Routecraft is a TypeScript framework for AI automation. A capability is a route: a typed pipeline from a source, through operations, to a destination. The same route is an MCP tool for Claude or Cursor, a tool for an agent you run yourself, an HTTP endpoint, or a scheduled job, depending only on its source. Agents are routes too, with the same guardrails around a model call as around any other step. Nothing is reachable until you write a route for it.

## Five minutes: an agent you own

[craft-harness](https://github.com/routecraftjs/craft-harness) is a complete agent built out of Routecraft capabilities: chat, a sandboxed shell, web fetch and search, a workspace, memory, a scheduler, human approvals, and the editor capabilities. Every one of them is an ordinary route in `capabilities/` you can read on one screen and change.

```bash
bunx create-routecraft my-agent --example https://github.com/routecraftjs/craft-harness
cd my-agent
bun run setup            # generates the project's own secrets into .env and .routecraft/
# add LLM_API_KEY to .env
bun run dev
```

From another terminal:

```bash
bun run exec chat --session=demo --message="what can you do?"
```

The instance is walled, the settings file carries the credential, and the transcript is a file `--session` names. The same conversation is reachable over MCP at `http://localhost:8081/mcp` and from your editor over the Agent Client Protocol.

## What a capability looks like

```ts
import { craft, mail } from '@routecraft/routecraft'
import { mcp } from '@routecraft/ai'
import { z } from 'zod'

const SendTeamEmail = z.object({
  to: z
    .string()
    .email()
    .refine((email) => email.endsWith('@company.com'), 'Can only send to @company.com addresses'),
  subject: z.string(),
  message: z.string(),
})

// The route id is the tool name; description and input schema live on the
// route, so every call is validated before any of your code runs.
export default craft()
  .id('send-team-email')
  .description('Send an email to a team member')
  .input({ body: SendTeamEmail })
  .from(mcp())
  .transform(({ to, subject, message }) => ({ to, subject, text: message }))
  .to(mail()) // the account comes from craft.config.ts
```

The source decides the door. `.from(mcp())` makes it an MCP tool. `.from(direct())` makes it a capability any local agent can call and `craft exec` can run. `.from(http())` makes it an endpoint. `.from(cron())` makes it a job. The steps in between do not change.

## An agent is a route too

```ts
import { craft, direct } from '@routecraft/routecraft'
import { agent, tools } from '@routecraft/ai'
import { z } from 'zod'

export default craft()
  .id('assistant')
  .description('Answer a question with the tools this project defines')
  .input({ body: z.object({ question: z.string() }) })
  .from(direct())
  .to(
    agent<{ question: string }>({
      model: 'anthropic:claude-opus-4-7',
      system: 'Be useful. Say what you did.',
      user: (ex) => ex.body.question,
      tools: tools(['Direct(send-team-email)']),
    }),
  )
```

Tools are an allowlist of capabilities, never a blacklist. An agent can also be a markdown file under `agents/` with frontmatter for its model and tools, which `craft start` discovers with everything else in the project. Because the agent is a step in a route, `.authorize()`, `.throttle()`, `.retry()`, `.timeout()` and `.circuitBreaker()` apply to the model call exactly as to any other step.

## What you get

- **Work that survives a restart.** [`.suspend()`](https://routecraft.dev/docs/reference/operations/suspend) parks an exchange in a store, and [`.resume()`](https://routecraft.dev/docs/reference/operations/resume) revives it by token, hours or days later, from any transport. [Durable agents](https://routecraft.dev/docs/advanced/durable-agents) park mid-conversation the same way.
- **Agents with sessions and background tools.** A conversation is a record a person owns; a tool can hand a long job to a route and come back when it finishes. [Agent adapter](https://routecraft.dev/docs/reference/adapters/agent).
- **Talk to your agents from your editor.** `craft acp` and the `acp` config key serve the Agent Client Protocol. [Talk from your editor](https://routecraft.dev/docs/advanced/talk-from-your-editor).
- **MCP both ways.** Expose routes as tools with `mcp()` and the `mcp` plugin; call other servers' tools as `MCP(server:tool)` in an agent's tool list. [Expose as MCP](https://routecraft.dev/docs/advanced/expose-as-mcp), [call an MCP](https://routecraft.dev/docs/advanced/call-an-mcp).
- **Isolated host execution.** [`shell()`](https://routecraft.dev/docs/reference/adapters/shell) runs commands in an isolation tier, including a throwaway Docker container per command, with egress denied by default.
- **A management API and a CLI to drive it.** The [ops plugin](https://routecraft.dev/docs/reference/plugins/opsplugin) serves health, readiness, a route listing and dispatch behind scope-gated tiers; `craft exec` and `craft ops` are its clients. [CLI reference](https://routecraft.dev/docs/reference/cli).
- **Secure by design.** JWT, JWKS and API-key validators, `.authorize()` at route entry, principals that follow an exchange through every hop. [Securing capabilities](https://routecraft.dev/docs/advanced/securing-capabilities).

## Add Routecraft to an existing project

```bash
bunx create-routecraft my-app
```

Expose a capability to Claude Desktop by adding it to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": ["@routecraft/cli", "run", "./capabilities/send-team-email.ts"]
    }
  }
}
```

Now talk to Claude: *"Send an email to john@company.com thanking him for yesterday's meeting"*. Claude discovers the tool and calls it with validated input.

> The `craft` CLI runs on Bun (>=1.1.0). Node users embed `@routecraft/routecraft` programmatically; see the [Programmatic Invocation guide](https://routecraft.dev/docs/advanced/programmatic-invocation).

📚 [Get Started](https://routecraft.dev/docs/introduction) | [Project structure](https://routecraft.dev/docs/introduction/project-structure) | [Examples](https://routecraft.dev/docs/examples) | [API Reference](https://routecraft.dev/docs/reference)

## Monorepo Structure

- `packages/routecraft` – Core library (builder, DSL, context, adapters, consumers, the ops plugin)
- `packages/ai` – AI integrations: LLM providers, agents, embeddings, MCP server / client, ACP
- `packages/cli` – `craft` CLI to run capabilities and start contexts (Bun >= 1.1.0)
- `packages/create-routecraft` – Project scaffolder (`bunx create-routecraft`)
- `packages/eslint-plugin-routecraft` – ESLint rules for capability authoring
- `packages/prettier-plugin-routecraft` – Prettier plugin for compact DSL formatting
- `packages/os` – System-native adapters: isolated subprocess execution via `shell()`, browser automation via `agentBrowser()`
- `packages/testing` – Test utilities (`testContext`, spy logger, `mockAdapter`, fixtures)
- `skills/` – Agent Skills for authoring Routecraft (Claude Code, Cursor, Codex, Windsurf, Cline, Continue, Copilot, ...; `bunx skills add routecraftjs/routecraft`). See [skills/README.md](./skills/README.md)
- `apps/routecraft.dev` – Documentation site (docs, examples, guides)
- `examples/` – Runnable example capabilities

## Examples

Browse runnable examples in [`examples/src/`](./examples/src/): `hello-world.ts`, `mcp-greet.ts`, `agent.ts`, `find-product.ts`, `mail-noreply-notify.ts`, `programmatic-invocation.ts`, `split.ts`. Each demonstrates a different feature combination.

Try one:

```bash
bun install
bun run build
bunx craft run ./examples/dist/mcp-greet.js
```

For end-to-end walkthroughs, see [the docs site](https://routecraft.dev/docs/examples).

## Contributing

Contributions are welcome! Please read our contribution guide at https://routecraft.dev/docs/community/contribution-guide for guidelines on how to propose changes, add adapters, and write capabilities.

## License

Licensed under the [Apache 2.0 License](./LICENSE).
