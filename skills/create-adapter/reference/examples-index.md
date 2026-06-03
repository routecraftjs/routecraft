# Adapter examples index

Pick the row that best matches what the user is building. Then `WebFetch` both URLs in that row before writing.

Each "Read this doc" link points to that adapter's own reference page (its options, exchange shape, and usage), not the combined adapters index. That keeps the context returned to you specific to the closest existing adapter. For the general authoring guide that applies to every adapter, see the Useful URLs in `SKILL.md` (adapters reference and the custom-adapters guide).

| If the user wants... | Read this doc | Then study this example |
|---|---|---|
| HTTP request or response (REST, webhook caller, JSON API) | https://routecraft.dev/raw/docs/reference/adapters/http.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/http/index.ts |
| Polling or scheduled trigger on an interval | https://routecraft.dev/raw/docs/reference/adapters/cron.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/cron/index.ts |
| Reading or writing files on disk | https://routecraft.dev/raw/docs/reference/adapters/file.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/file/index.ts |
| Parsing CSV input (rows in, rows out) | https://routecraft.dev/raw/docs/reference/adapters/csv.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/csv/index.ts |
| Parsing JSON or JSONL streams | https://routecraft.dev/raw/docs/reference/adapters/jsonl.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/jsonl/index.ts |
| Two-sided protocol (server inbox plus client outbox, e.g. mail or queues) | https://routecraft.dev/raw/docs/reference/adapters/mail.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/mail/index.ts |
| In-process direct-call routing (call one route from another) | https://routecraft.dev/raw/docs/reference/adapters/direct.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/direct/index.ts |
| Logging or side-effect-only destination | https://routecraft.dev/raw/docs/reference/adapters/log.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/log/index.ts |
| HTML scraping or DOM querying | https://routecraft.dev/raw/docs/reference/adapters/html.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/html/index.ts |
| Cosine similarity or embedding-based search transformer | https://routecraft.dev/raw/docs/reference/adapters/cosine.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/cosine/index.ts |
| Simple in-memory source for tests or fixed payloads | https://routecraft.dev/raw/docs/reference/adapters/simple.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/simple/index.ts |
| Group-by or stateful aggregation transformer | https://routecraft.dev/raw/docs/reference/adapters/group.md | https://raw.githubusercontent.com/routecraftjs/routecraft/main/packages/routecraft/src/adapters/group/index.ts |

If none of the rows are a clean match, pick the closest by **mechanism** (request/response, polling, streaming, two-sided) rather than by **domain**. The mechanism determines the file layout; the domain only changes the option types and the body shape.

When you do not see a row that matches, recommend the closest one and flag the mismatch in your reply so the user can decide whether to add a new mapping to this index.
