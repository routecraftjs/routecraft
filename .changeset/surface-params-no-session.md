---
"@routecraft/ai": minor
---

**Breaking (canary-only type):** the params callback of `surface()` no longer takes `sessionId` (#748).

`SurfaceRequestParams` omits `sessionId` from every method and forbids it, so `surface('fs/read_text_file', (ex) => ({ path: ex.body.path }))` is the whole call and a callback that names a session does not compile. The adapter fills the running turn's session in, which is the only conversation a route can mean: a route that could name another would be addressing another person's editor. Remove the `sessionId: ''` placeholder from every `surface()` callback. The type shipped only in a 0.7.0 canary, so nothing released changes.
