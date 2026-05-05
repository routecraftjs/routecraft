---
name: create-adapter
description: Author a new Routecraft adapter (source, destination, transformer, or multi-role). Use when the user asks to add a new integration, connector, endpoint type, or producer or consumer of exchanges.
allowed-tools: Read Glob Grep WebFetch Bash(bun run lint:*) Bash(bun run typecheck:*) Bash(bun run test:*)
---

# Create a Routecraft adapter

Adapters are how Routecraft talks to the outside world. A source produces exchanges, a destination consumes them, and a transformer changes the body in flight. Many adapters fill more than one role.

You are writing this adapter for the user. Treat the linter (`bun run lint`) as authoritative once you have written the code: if it disagrees, the linter wins.

## When to use this skill

Use this skill when the user asks to:

- Add a new integration (Stripe, Slack, S3, a database, a queue)
- Wrap a third-party SDK so it can be used inside a capability
- Replace bespoke `process()` calls with a reusable adapter
- Add a transformer that turns one body shape into another

If the user only needs a one-shot data transformation inside a single capability, use `.transform()` or `.process()` directly instead. If the work is reusable across capabilities, it belongs in an adapter.

## Step 1: clarify

Before writing, confirm answers to these questions. Ask the user only the ones that are not already obvious from context.

1. **Which roles does the adapter play?** Source (`.from(...)`), Destination (`.to(...)`, `.enrich(...)`, `.tap(...)`), Transformer (`.transform(...)`), or several of these?
2. **How is data produced or consumed?** Request/response (HTTP-style)? Polling on an interval? Long-running stream or subscription? Filesystem? Two-sided protocol (server + client like mail)?
3. **Where do options come from?** Per-call options on the factory, or context-wide defaults configured via a plugin?
4. **What is the exchange shape?** What does `body` look like for sources you produce, and what does `body` need to look like for destinations you consume?

## Step 2: pick the closest example

Read [`reference/examples-index.md`](reference/examples-index.md) and pick the row that best matches the answers above. The index maps intent to the relevant public doc page and the closest existing adapter on GitHub.

Then, in this order:

1. `WebFetch` the linked doc page (raw markdown variant on `routecraft.dev/raw/docs/...`)
2. `WebFetch` the linked example adapter source on GitHub (use the `raw.githubusercontent.com` URL)
3. If the user is in this monorepo, `Read` `packages/routecraft/src/adapters/<closest>/` end to end. Pay attention to file layout, the factory, the `tagAdapter` call, and the types module
4. Only after that, write the new adapter

Do not write the adapter from memory. The patterns are precise and the examples are short. Read first.

## Step 3: write the adapter

Create the adapter under `packages/routecraft/src/adapters/<concept>/` if you are inside this monorepo, or under your project's adapters folder otherwise. Mirror the file layout of the example you read. Typical files:

- `index.ts` -- the public factory function. Calls `tagAdapter(instance, factory, factoryArgs(...))`. This is what users import
- `source.ts` -- the source class (if applicable)
- `destination.ts` -- the destination class (if applicable)
- `transformer.ts` -- the transformer class (if applicable)
- `shared.ts` -- option parsing or helpers shared between the role files
- `types.ts` -- exported option and result types

Authoring rules to keep in mind while writing:

- **Naming**: classes are `{Concept}{Role}Adapter` (e.g. `HttpDestinationAdapter`, `CronSourceAdapter`). The factory function is the lowercase concept (`http`, `cron`)
- **Single factory per concept**: one factory, one concept. Use overloads to discriminate roles by `arguments.length` and `typeof`, never by inspecting option values
- **Tagging**: every factory return value goes through `tagAdapter(instance, factory, factoryArgs(...))`. The eslint plugin and tests rely on this
- **Two-sided naming**: when an adapter is both server and client, name the option types `{Concept}ServerOptions` and `{Concept}ClientOptions`, and export the union as `{Concept}Options`. If the two roles share fields, factor them into `{Concept}BaseOptions` and have both `Server` and `Client` extend it; if they do not, declare each independently. Source/Destination is for *interface* names; Server/Client is for *option type* names
- **Store keys**: use `Symbol.for("routecraft.adapter.<concept>.<key>")` so keys survive duplicate package copies in the same process
- **No mutation**: transformers return new objects via spread (`{ ...exchange, body: newBody }`). Do not mutate the incoming exchange
- **Errors**: throw at adapter boundaries with a stable `rc` error code from `@routecraft/routecraft`. Capabilities catch and surface these via the capability-level error handler

## Step 4: write tests

Tests live in the package's `test/` directory: `packages/<pkg>/test/<name>.test.ts`. Do not colocate tests next to source. Every test must have a JSDoc with `@case`, `@preconditions`, `@expectedResult`. Prefer the helpers from `@routecraft/testing`:

- `testContext()` to build an isolated context
- `spy()` for destinations whose payload you want to assert on
- `pseudo("name", options)` for a stand-in source or destination
- `mockAdapter(factory, {...})` to assert how a factory was called

For the full pattern, fetch:

```
https://routecraft.dev/raw/docs/introduction/testing.md
```

## Step 5: verify

Run, in this order, until each is clean:

```bash
bun run typecheck
bun run lint
bun run test
```

Use `bun run <script>` (not `bun <script>`) so Bun invokes the package.json script rather than its built-in test runner. If `bun run lint` complains, fix the code rather than silencing the rule. The linter encodes Routecraft's authoring rules; it is allowed to be stricter than this skill. If the linter does not catch something the user expected it to catch, that is a follow-up for the lint package, not a workaround here.

## Useful URLs

- Adapters reference: https://routecraft.dev/raw/docs/reference/adapters.md
- Creating adapters guide: https://routecraft.dev/raw/docs/advanced/custom-adapters.md
- Adapters introduction: https://routecraft.dev/raw/docs/introduction/adapters.md
- All Routecraft AI-friendly docs index: https://routecraft.dev/llms.txt
