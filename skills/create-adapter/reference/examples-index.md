# Adapter examples index

Pick the row that best matches what the user is building. Then `WebFetch` both URLs in that row before writing.

| If the user wants... | Read this doc | Then study this example |
|---|---|---|
| HTTP request or response (REST, webhook caller, JSON API) | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/http/index.ts |
| Polling or scheduled trigger on an interval | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/cron/index.ts |
| Reading or writing files on disk | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/file/index.ts |
| Parsing CSV input (rows in, rows out) | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/csv/index.ts |
| Parsing JSON or JSONL streams | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/jsonl/index.ts |
| Two-sided protocol (server inbox plus client outbox, e.g. mail or queues) | https://routecraft.dev/raw/docs/advanced/custom-adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/mail/index.ts |
| In-process direct-call routing (call one route from another) | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/direct/index.ts |
| Logging or side-effect-only destination | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/log/index.ts |
| HTML scraping or DOM querying | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/html/index.ts |
| Cosine similarity or embedding-based search transformer | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/cosine/index.ts |
| Simple in-memory source for tests or fixed payloads | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/simple/index.ts |
| Group-by or stateful aggregation transformer | https://routecraft.dev/raw/docs/reference/adapters.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/group/index.ts |

If none of the rows are a clean match, pick the closest by **mechanism** (request/response, polling, streaming, two-sided) rather than by **domain**. The mechanism determines the file layout; the domain only changes the option types and the body shape.

When you do not see a row that matches, recommend the closest one and flag the mismatch in your reply so the user can decide whether to add a new mapping to this index.
