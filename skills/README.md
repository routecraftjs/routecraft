# Routecraft Agent Skills

Agent Skills for authoring Routecraft code. Each skill is a navigator: it asks a few clarifying questions, points the agent at the closest existing example plus the matching page on [routecraft.dev](https://routecraft.dev), and then has the agent verify its work by running `bun run lint`, `bun run typecheck`, and `bun run test` until they pass.

These skills follow the [Agent Skills](https://agentskills.io) open standard, so they work in any agent that reads `SKILL.md` files: Claude Code, Cursor, Codex, Windsurf, Cline, Continue, Copilot, and 50+ others. Routecraft's ambition is for agents to write good Routecraft code by default; these skills are one half of that contract (the linter is the other half).

The skills live at the repo root in `/skills/` and are not published to npm. They are distributed in two ways: directly from this GitHub repo via Vercel's [`skills`](https://github.com/vercel-labs/skills) CLI (universal, any agent), or as a Claude Code plugin via the routecraft marketplace.

## Skills

- **`create-adapter`** -- author a new Routecraft adapter (source, destination, transformer, or multi-role)
- **`create-capability`** -- author a new Routecraft capability (the user-facing pipeline produced by `craft()`: linear, split or aggregate, choice, batched)

## Install

### Universal (any agent: Claude Code, Cursor, Codex, Windsurf, Cline, Continue, Copilot, OpenHands, ...)

Use Vercel's [`skills`](https://github.com/vercel-labs/skills) CLI; it supports 50+ agents and writes the skills to the right place for whichever one you use.

```bash
bunx skills add routecraftjs/routecraft
# or with npx:
npx skills add routecraftjs/routecraft
```

Useful flags:

- `--skill create-adapter` -- install a single skill instead of all
- `-a claude-code` -- target a specific agent (defaults to detect)
- `-g` -- install globally (user directory) instead of project
- `--list` -- list available skills without installing

### Claude Code (plugin marketplace)

```text
/plugin marketplace add routecraftjs/routecraft
/plugin install routecraft-skills@routecraft
```

The skills become available as `/routecraft-skills:create-adapter` and `/routecraft-skills:create-capability`.

### Other agents (manual)

The skills are just files. Clone the repo (or download the `/skills/` directory) and follow your agent's docs for `SKILL.md` discovery.

## How a skill works

Every skill follows the same shape:

1. **Clarifying questions** -- 2 to 4 short questions to narrow the user's intent
2. **Pick the closest example** -- a curated table mapping intent to a doc URL plus a matching example on GitHub
3. **Read first, then write** -- the agent reads both before writing
4. **Authoring checklist** -- short, agent-actionable rules
5. **Verify** -- `bun run lint && bun run typecheck && bun run test`, iterate until clean

The skill bodies link to AI-friendly docs at `https://routecraft.dev/raw/docs/<page>.md` and `https://routecraft.dev/llms.txt`. They never link into `.standards/*` (those target framework contributors, not agents writing user code).

## Versioning

The skills are versioned with the rest of the Routecraft monorepo. The Vercel `skills` CLI installs from a git ref (default `main`); pin to a tag or commit if you want a specific version.

## Contributing

Skills get better as the linked examples grow. To propose a new example mapping, edit the relevant `<skill>/reference/examples-index.md` and open a PR.

## License

Apache 2.0
