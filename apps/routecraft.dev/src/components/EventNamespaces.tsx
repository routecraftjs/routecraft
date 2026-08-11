import { anchorHref, eventNamespaces } from '@/lib/docs-catalogue'
import { type DocsChannelProps } from '@/lib/docs-channel'

/** The page this map indexes, relative to the channel root. */
const EVENTS_ROUTE = 'reference/events'

export function EventNamespaces({ channel = 'latest' }: DocsChannelProps) {
  // Each row jumps to its section on this channel's events page. The generator
  // guarantees the heading exists, so resolving the id here only translates the
  // declared anchor into the one Markdoc renders.
  const visible = eventNamespaces(channel).map((g) => ({
    ...g,
    href: anchorHref(channel, EVENTS_ROUTE, g.anchor),
  }))
  const total = visible.reduce((n, g) => n + g.events.length, 0)
  return (
    <div className="not-prose mt-8 border border-ink/15 bg-paper-deep/30">
      <header className="flex items-center gap-3 border-b border-ink/15 px-5 py-3">
        <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
        <h3 className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/65 uppercase">
          Namespace map
        </h3>
        <span className="ml-auto font-mono text-[0.65rem] tracking-[0.22em] text-ink/45 tabular-nums">
          {total} events / {visible.length} namespaces
        </span>
      </header>
      <ul role="list" className="divide-y divide-ink/10">
        {visible.map((g) => (
          <li key={g.pattern} className="px-5 py-4">
            <div className="flex items-baseline gap-3">
              <a
                href={g.href}
                className="group inline-flex items-baseline gap-2 transition"
              >
                <span
                  aria-hidden="true"
                  className="font-mono text-[0.85rem] text-cobalt-500 transition group-hover:translate-x-0.5"
                >
                  ▸
                </span>
                <code className="font-mono text-[0.9rem] font-medium text-ink transition group-hover:text-cobalt-500">
                  {g.pattern}
                </code>
              </a>
              <span className="ml-auto font-mono text-[0.6rem] tracking-[0.18em] text-ink/45 uppercase tabular-nums">
                {g.events.length}
              </span>
            </div>
            <p className="mt-1.5 pl-6 font-mono text-[0.78rem] leading-[1.7] text-ink/65">
              {g.events.map((e, i) => (
                <span key={e}>
                  {i > 0 && <span className="text-ink/25"> · </span>}
                  {e}
                </span>
              ))}
            </p>
            {g.note && (
              <p
                className="mt-1.5 pl-6 font-editorial text-[0.85rem] text-ink/55 italic"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 100' }}
              >
                {g.note}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
