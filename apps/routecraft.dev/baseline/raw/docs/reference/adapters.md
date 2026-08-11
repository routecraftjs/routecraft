# Adapters

Every source, destination, enricher, transformer, and processor in Routecraft. Each card opens its own reference page with the full signature, options, and examples.

{% adapter-grid /%}

## Parse error handling

Source adapters that convert raw bytes into a structured body (`json`, `html`, `csv`, `jsonl`, `xml`, `mail`) accept a uniform `onParseError` option that controls what happens when parsing fails (malformed JSON, structurally-invalid CSV row, broken MIME, etc.). The default is `'fail'`.

All three modes are observable on the events bus, parse failures are never silent.

| Value | Lifecycle events | Use case |
|-------|------------------|----------|
| `'fail'` (default) | `exchange:started` to `exchange:failed` (or `error:caught` if `.error()` recovers) with `error.rc === 'RC5016'`. Streaming adapters continue to the next item. | Per-item observability with stream continuation. |
| `'abort'` | `exchange:started` to `exchange:failed` for the bad item, then the source rejects and `context:error` fires. | Atomic-load semantics where partial data is unacceptable. |
| `'drop'` | `exchange:started` to `exchange:dropped` with `reason: 'parse-failed'`. No `.error()` invocation. Streaming adapters continue. | Lossy upstreams (scraping, public feeds) where malformed items are expected but should still be counted. |

```ts
// Default: route per-line parse errors through .error(), keep streaming.
craft()
  .from(jsonl({ path: './events.jsonl', chunked: true }))
  .error((err, exchange) => {
    log.warn({ err, line: exchange.headers['routecraft.jsonl.line'] }, 'bad line')
    return null
  })
  .filter((e) => e.body != null)
  .to(db())

// Stop the stream on the first malformed row (atomic-import semantics).
craft().from(csv({ path: './daily.csv', chunked: true, onParseError: 'abort' })).to(load())

// Drop unparseable mail with structured event observability.
craft().from(mail('INBOX', { onParseError: 'drop' })).to(process())

// Subscribe to parse drops across all routes:
ctx.on('route:exchange:dropped', ({ details }) => {
  if (details.reason === 'parse-failed') metrics.increment('source.parse.dropped')
})
```

Internally, all three modes defer parsing to a synthetic first pipeline step injected by the runtime, so `exchange:started` fires before parsing runs. The synthetic step decides per-mode whether to throw (`'fail'`/`'abort'`) or emit `exchange:dropped` (`'drop'`).

## Related

- [Operations](/docs/reference/operations) -- Verbs that act on the exchange between source and destination.
- [Configuration](/docs/reference/configuration) -- Project-level options and craft.config.ts.
- [Errors](/docs/reference/errors) -- Error codes, lifecycle, and recovery via .error().
