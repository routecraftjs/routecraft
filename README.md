<div align="center">

  <img src="./routecraft-sticker.svg" alt="Routecraft" width="300" />

  <p><strong>AI automation as code</strong></p>

  <a href="https://github.com/routecraftjs/routecraft/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/routecraftjs/routecraft/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.1%2B-fbf0df?logo=bun">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%2B-3c873a?logo=node.js">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9%2B-3178c6?logo=typescript">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache%202.0-blue"></a>
  <a href="https://github.com/routecraftjs/routecraft/issues"><img alt="Issues" src="https://img.shields.io/github/issues/routecraftjs/routecraft"></a>
  <a href="https://github.com/routecraftjs/routecraft/pulls"><img alt="PRs" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>

</div>

## About

Routecraft is a code-first automation platform for TypeScript. Write routes that send emails, manage calendars, and automate work. Expose them to any AI agent via MCP.

## Why Routecraft?

- ✅ **AI that does real work** - Send emails, schedule meetings, automate tasks
- ✅ **Code, not configs** - TypeScript all the way with full IDE support
- ✅ **Works with Claude & Cursor** - Expose tools via MCP automatically
- ✅ **Secure by design** - AI only accesses the capabilities you expose

## Quick Start

### Write a tool

```ts
import { mcp } from '@routecraft/ai'
import { craft, mail } from '@routecraft/routecraft'
import { z } from 'zod'

// Define a tool AI can call
export default craft()
  .from(mcp('send-team-email', {
    description: 'Send email to team members',
    schema: z.object({ 
      to: z.string().email().refine(
        email => email.endsWith('@company.com'),
        'Can only send to @company.com addresses'
      ),
      subject: z.string(),
      message: z.string()
    })
  }))
  .to(mail())  // Config loaded from context
```

### Expose to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "bunx",
      "args": ["@routecraft/cli", "run", "./routes/tools.mjs"]
    }
  }
}
```

> The `craft` CLI runs on Bun (>=1.1.0). Node users embed `@routecraft/routecraft` programmatically; see the [Programmatic Invocation guide](https://routecraft.dev/docs/advanced/programmatic-invocation).

Now talk to Claude: *"Send an email to john@example.com thanking him for yesterday's meeting"*

Claude discovers your tool and uses it automatically. ✨

📚 [Get Started](https://routecraft.dev/docs/introduction) | [Examples](https://routecraft.dev/docs/examples) | [API Reference](https://routecraft.dev/docs/reference)

## Key Features

- **Make AI useful** - Send emails, schedule meetings, automate tasks
- **Code-first** - TypeScript with full IDE support, testing, and version control
- **MCP native** - Works with Claude Desktop, Cursor, and any MCP client
- **Type-safe** - Zod-powered validation ensures data integrity
- **Deploy anywhere** - Run locally, self-host, or use our upcoming cloud platform

## Monorepo Structure

- `packages/routecraft` – Core library (builder, DSL, context, adapters, consumers)
- `packages/ai` – AI integrations: LLM providers, agents, embeddings, MCP server / client
- `packages/browser` – Browser automation adapter (headless / headed via agent-browser)
- `packages/cli` – `craft` CLI to run capabilities and start contexts (Bun >= 1.1.0)
- `packages/create-routecraft` – Project scaffolder (`bunx create-routecraft`)
- `packages/eslint-plugin-routecraft` – ESLint rules for capability authoring
- `packages/os` – System-native adapters (shell, etc.) – placeholder, in development
- `packages/testing` – Test utilities (`testContext`, spy logger, `mockAdapter`, fixtures)
- `skills/` – Agent Skills for authoring Routecraft (Claude Code, Cursor, Codex, Windsurf, Cline, Continue, Copilot, ...; `bunx skills add routecraftjs/routecraft`). See [skills/README.md](./skills/README.md)
- `apps/routecraft.dev` – Documentation site (docs, examples, guides)
- `examples/` – Runnable example capabilities

## Examples

Browse runnable examples in [`examples/src/`](./examples/src/) — `hello-world.ts`, `mcp-greet.ts`, `agent.ts`, `mail-noreply-notify.ts`, `programmatic-invocation.ts`, `split.ts`. Each demonstrates a different feature combination.

Try one:

```bash
bun install
bun run build
bunx craft run ./examples/dist/mcp-greet.js
```

For end-to-end walkthroughs, see [the docs site](https://routecraft.dev/docs/examples).

## Contributing

Contributions are welcome! Please read our contribution guide at https://routecraft.dev/docs/community/contribution-guide for guidelines on how to propose changes, add adapters, and write routes.

## License

Licensed under the [Apache 2.0 License](./LICENSE).
