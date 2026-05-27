---
title: pseudo
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
pseudo<Opts>(name?: string, options?: PseudoOptions): PseudoFactory<Opts>
pseudo<Opts>(name: string, options: PseudoKeyedOptions): PseudoKeyedFactory<Opts>
```

Create a **typed placeholder adapter** that satisfies the DSL at compile time but throws at runtime (or no-ops when `runtime: "noop"`). Use it to write example routes and documentation that compile without real adapter implementations; later, swap in the real adapter by changing only the import.

The returned factory can be used in `.from()`, `.to()`, `.enrich()`, `.tap()`, and `.process()`. Specify the **result type** with a generic on the call so the route body type flows correctly:

```ts
import { craft, timer, log, pseudo } from "@routecraft/routecraft";

// Option types (move to real adapter package later)
interface McpCallOptions {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}

interface GmailListResult {
  messages: { id: string; subject?: string }[];
  nextPageToken?: string;
}

const mcp = pseudo<McpCallOptions>("mcp");

// Object-only call: mcp<Result>(options)
craft()
  .from(timer({ intervalMs: 60_000 }))
  .enrich(
    mcp<GmailListResult>({
      server: "gmail",
      tool: "messages.list",
      args: { query: "is:unread" },
    }),
  )
  .split((r) => r.messages)
  .tap(log());
```

**Keyed (string-first) signature:** use `args: "keyed"` when the real adapter takes a key then options (e.g. queue name, table name):

```ts
const queue = pseudo<{ ttl?: number }>("queue", { args: "keyed" });

craft()
  .from(source)
  .to(queue<void>("outbound", { ttl: 5000 }));
```

**Options:**

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `runtime` | `"throw"` or `"noop"` | `"throw"` | `"throw"` (default): throw with adapter name when executed. `"noop"`: resolve without error (for tests). |
| `args` | `"keyed"` | -- | Set to `"keyed"` to get a factory `(key: string, opts?) => PseudoAdapter<R>`. |

**Replacing with a real adapter:** keep the same call shape; only the import changes:

```ts
// Before (pseudo)
import { pseudo } from "@routecraft/routecraft";
const mcp = pseudo<McpCallOptions>("mcp");

// After (real adapter)
import { mcp } from "@routecraft/mcp-adapter";
// mcp<GmailListResult>({ server, tool, args }) still works
```

**Exported types:** `PseudoAdapter<R>`, `PseudoFactory<Opts>`, `PseudoKeyedFactory<Opts>`, `PseudoOptions`, `PseudoKeyedOptions`
