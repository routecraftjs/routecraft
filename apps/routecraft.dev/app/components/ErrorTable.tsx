import { useMemo, useState } from 'react'

import { anchorHref, errors } from '@/lib/docs-catalogue'
import { type DocsChannelProps } from '@/lib/docs-channel'

/** The page this table indexes, relative to the channel root. */
const ERRORS_ROUTE = 'reference/errors'

export function ErrorTable({ channel = 'latest' }: DocsChannelProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('All')

  // Every row addresses the `## RCxxxx` section of this channel's errors page.
  // Resolving the id (rather than lowercasing the code) is what makes the link
  // land: Markdoc slugifies `RC1001` to `rc-1001`. The generator guarantees the
  // heading exists, so the fallback to the page itself is only for a build
  // whose pages moved under it.
  const rows = useMemo(
    () =>
      errors(channel).map((e) => ({
        ...e,
        href: anchorHref(channel, ERRORS_ROUTE, e.code),
      })),
    [channel],
  )

  // Derived from the rows, not restated here: a category present in the data
  // but missing from a hard-coded list would render under All with no way to
  // filter to it, and a removed one would leave a button matching nothing.
  const categories = useMemo(
    () => ['All', ...new Set(rows.map((e) => e.category))],
    [rows],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((e) => {
      if (category !== 'All' && e.category !== category) return false
      if (!q) return true
      return (
        e.code.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q)
      )
    })
  }, [rows, query, category])

  return (
    <div className="not-prose mt-8 flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by code, message, or category"
            aria-label="Search errors"
            className="w-full border border-ink/20 bg-paper-deep/40 px-4 py-2.5 font-mono text-[0.85rem] text-ink placeholder:text-ink/45 focus:border-cobalt-500 focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((cat) => {
            const active = cat === category
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                aria-pressed={active}
                className={
                  'inline-flex items-center border px-2.5 py-1 font-mono text-[0.65rem] tracking-[0.18em] uppercase transition ' +
                  (active
                    ? 'border-cobalt-500 bg-cobalt-500 text-paper'
                    : 'border-ink/25 text-ink/65 hover:border-ink/45 hover:text-ink')
                }
              >
                {cat}
              </button>
            )
          })}
        </div>
      </div>

      <div className="overflow-hidden border border-ink/15">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-ink/15 bg-paper-deep/40 font-mono text-[0.6rem] tracking-[0.22em] text-ink/55 uppercase">
              <th className="px-4 py-2 text-left">Code</th>
              <th className="px-4 py-2 text-left">Category</th>
              <th className="px-4 py-2 text-left">Message</th>
              <th className="w-20 px-4 py-2 text-center">Retry</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-10 text-center font-editorial text-[1rem] text-ink/55 italic"
                >
                  No errors match this filter.
                </td>
              </tr>
            ) : (
              filtered.map((e, i) => (
                <tr
                  key={e.code}
                  className={
                    'border-b border-ink/10 transition last:border-b-0 hover:bg-paper-deep/30 ' +
                    (i % 2 === 1 ? 'bg-paper-deep/15' : '')
                  }
                >
                  <td className="px-4 py-2.5">
                    <a
                      href={e.href}
                      className="font-mono text-[0.85rem] font-semibold text-cobalt-500 hover:text-cobalt-600"
                    >
                      {e.code}
                    </a>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[0.7rem] tracking-[0.16em] text-ink/65 uppercase">
                    {e.category}
                  </td>
                  <td className="px-4 py-2.5 text-[0.9rem] text-ink">
                    {e.message}
                  </td>
                  <td
                    className="px-4 py-2.5 text-center font-mono text-[0.7rem] tracking-[0.16em] uppercase"
                    title={
                      e.retryable
                        ? 'Retryable by default'
                        : 'Not retried automatically'
                    }
                  >
                    {e.retryable ? (
                      <span className="text-cobalt-500">Yes</span>
                    ) : (
                      <span className="text-ink/40">No</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="font-mono text-[0.65rem] tracking-[0.18em] text-ink/45 uppercase">
        Showing {filtered.length} of {rows.length} codes
      </p>
    </div>
  )
}
