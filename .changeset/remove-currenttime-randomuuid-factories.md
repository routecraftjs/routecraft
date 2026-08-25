---
"@routecraft/ai": minor
---

**Breaking: `currentTime()` and `randomUuid()` are removed from `@routecraft/ai` (#596).**

Both were fn factories you assigned a tool name in `agentPlugin({ functions })`. Both are gone, with no deprecation cycle: the whole v0 API is unstable, so breaking changes land directly and get declared loudly rather than aged out.

They fail the test every shipped export has to pass. Registering `CurrentTime: currentTime()` costs exactly the same declaration lines as writing the handler inline, so the export saved an import and cost the framework a public symbol to maintain, version and document forever. A clock is three lines of JavaScript. It should be yours, not ours.

**What to write instead.** Declare the fn inline in the same `functions:` block, under the same tool name, and every `tools([...])` reference keeps working unchanged:

```ts
CurrentTime: {
  description: "Current date and time in ISO 8601.",
  input: z.object({}),
  handler: () => new Date().toISOString(),
},
```

The `randomUuid()` replacement is the same shape with `handler: () => crypto.randomUUID()`.

Add `tags: ["read-only", "idempotent"]` (`["read-only"]` for the UUID fn) if you select tools by tag in a `tools((catalog) => ...)` builder, since the removed factories set those tags for you.

**Known external consumer:** eywa registers both today. The migration is the three-line swap above, once per fn, with no change to the agents that reference them.

`directTool(routeId, overrides?)` is unaffected and is now the only fn builder the framework ships.
