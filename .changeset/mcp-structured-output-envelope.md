---
"@routecraft/ai": minor
---

Publish `structuredContent` from the advertised schema, not the body's runtime shape (#574).

A route exposed with `.from(mcp())` that declares a non-object output was broken against a spec-compliant client on every call:

```ts
craft().id("get-price").output({ body: z.string() }).from(mcp());
```

`tools/call` attached `structuredContent` only when the published body happened to be a plain non-array object, so a string or array body skipped it while the tool still advertised an output schema. The installed `@modelcontextprotocol/client` throws on exactly that pair: *has an output schema but did not return structured content*.

**Wire-visible change: primitive and array output tools now return `structuredContent` where they previously returned text only.** On the 2025 protocol era it arrives in the SEP-2106 envelope, `{"result": "42.50"}`, matching the `{type:"object", properties:{result:...}}` advertisement the same era already projected that tool's `outputSchema` into. On the 2026 era the value is carried directly, unwrapped, as that era's wire shape allows. A client reading only the `content` text block sees no change, and a tool declaring an object output is byte-identical to before.

**A suspendable tool is repaired, not merely improved.** A route that can `.suspend()` advertises a `oneOf` root, which the 2025 era wrapped on the advertisement side while the acknowledgment went out bare. The acknowledgment additionally carries an enumerable symbol brand, which that era's `z.record(z.string(), ...)` wire schema rejects when it sits at the top of `structuredContent`. The two together meant every park over MCP answered with JSON-RPC `-32602` rather than an acknowledgment. Both are resolved by publishing the envelope the advertisement already promised.

The decision now comes from the advertised schema rather than the value in hand. The result is projected through the SDK's `Server.projectCallToolResult`, which is the seam the SDK exposes for low-level `setRequestHandler("tools/call")` authors, so the era's envelope rule is applied in one place for both the advertisement and the reply instead of being re-derived here. The projection covers proxied tools on the same path.

Wrapping stays a wire concern. `enforceAdvertisedOutput` still validates the route's declared schema unwrapped, and an author who wrote `.output({ body: z.string() })` never writes or sees `{ result: ... }`: the envelope is applied after the route's contract is satisfied and never reaches the body the pipeline carries.
