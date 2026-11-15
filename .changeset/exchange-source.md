---
"@routecraft/routecraft": minor
---

Every exchange records the source that admitted it. `sourceOf(exchange)` returns that source's `adapterId` (`routecraft.adapter.argv`, `routecraft.adapter.direct`, ...; `inline` for a source without one), read from the new engine-owned `routecraft.source` header, and `route:exchange:started` carries it as `source`. The engine stamps it at every ingress over any value the adapter supplied, so a hop through `direct()` is a new admission; a resumed exchange and `.split()` children keep theirs, and a step that returns its own headers (`.process()`, an `.enrich()` or `.aggregate()` aggregator) cannot change it.

A plugin hook takes `sources: [...]` and then runs only for exchanges those sources admitted, as well as matching `routes` / `tags`. A `beforeAuth` hook with `sources: ["routecraft.adapter.argv"]` supplies a principal for `craft run` while a `direct()` call to the same route with no principal is still refused. An empty list, or `sources` on a `perAttempt` wrapper, is `RC1115`. The selector names a door and is not authentication.

`routecraft.source` joins the engine-owned headers: `.header()` on it is `RC5003` and a mutate hook writing it is `RC1115`.
