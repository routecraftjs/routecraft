---
title: Project structure
---

Nuxt‑style discovery with a clear folder layout. {% .lead %}

```text
.
├─ routecraft.config.ts
├─ src/
│  ├─ routes/
│  │  ├─ index.route.ts
│  │  ├─ users/
│  │  │  ├─ [userId].route.ts
│  │  │  └─ list.route.ts
│  │  ├─ cron/
│  │  │  └─ hourly.route.ts
│  │  └─ channel/
│  │     └─ audit.route.ts
│  ├─ adapters/
│  ├─ plugins/
│  ├─ workers/
│  ├─ env/
│  └─ app.ts
└─ tests/
```

See discovery rules in the CLI page and dynamic params in Routes.

---

## title: Project structure

Recommended layout, discovery rules, route ids, and parameters. {% .lead %}

## Recommended layout

```text
.
├─ routecraft.config.ts
├─ src/
│  ├─ routes/
│  │  ├─ index.route.ts
│  │  ├─ users/
│  │  │  ├─ [userId].route.ts
│  │  │  └─ list.route.ts
│  │  ├─ cron/
│  │  │  └─ hourly.route.ts
│  │  └─ channel/
│  │     └─ audit.route.ts
│  ├─ adapters/            # custom adapters live here
│  │  ├─ http.ts
│  │  └─ mysql.ts
│  ├─ plugins/             # cross cutting helpers, logging, metrics
│  │  └─ observability.ts
│  ├─ workers/             # optional long-running workers
│  │  └─ user-enricher.worker.ts
│  ├─ env/                 # env schema and loader
│  │  └─ index.ts
│  └─ app.ts               # optional programmatic entry
└─ tests/
   └─ routes/
      └─ index.route.test.ts
└─ scripts/
   └─ build.ts
```

{% callout title="Why this mirrors Nuxt nicely" %}
Convention over configuration; dynamic segments via bracket names; default config filename with override when needed; plugins folder for cross-cutting features; zero glue to boot in common cases.
{% /callout %}

## Route id derivation

- Prefer setting an explicit id: `.from([{ id: 'hello-world' }, source])`
- If omitted, a UUID is generated in `RouteBuilder.from()`.

```ts
import { craft, simple } from '@routecraftjs/routecraft'

export default craft().from([{ id: 'my-job' }, simple('payload')])
```

## Bracket params and path-derived values

Planned: HTTP inbound adapters populate `headers.params` from bracket segments like `users/[userId].route.ts` or `/users/:userId`.

## Headers carry params and request metadata

Headers model context like params, query, method, url, and cookies.

```ts
import type { ExchangeHeaders } from '@routecraftjs/routecraft'

function useHeaders(h: ExchangeHeaders) {
  // h may include keys like method, url, query, cookies when provided by a source
}
```

## Discovery rules for the CLI

- Default root is `src/routes`
- Files ending with `.route.ts` or `.route.mjs` are discovered
- Folders compose the route id; file name before `.route` is the tail
- `index.route.ts` becomes the id of its folder
- Bracket segments define params: `users/[userId].route.ts`
- Files ending with `.test.ts` are ignored
- Files/folders starting with underscore are ignored
- `routecraft.config.ts` can change include/exclude

{% callout type="note" title="Current CLI behavior" %}
`craft run` walks supported files in a file or directory and loads default exports if they are a `RouteBuilder`/`RouteDefinition` or arrays thereof. Discovery by `.route.*` and param derivation is the convention; future versions may enforce it. See `packages/cli/src/run.ts`.
{% /callout %}
