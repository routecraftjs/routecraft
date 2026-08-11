import Link from 'next/link'

import { type AdapterRow, adapters } from '@/lib/docs-catalogue'
import {
  type DocsChannelName,
  type DocsChannelProps,
  docsChannelHref,
  withDocsChannel,
} from '@/lib/docs-channel'
import { type Section } from '@/lib/sections'
import { slug } from '@/lib/slug'

const categories = [
  'Core',
  'Test',
  'File',
  'Messaging',
  'Contacts',
  'Browser',
  'AI',
  'Clustering',
] as const

// Keyed by the role strings the data file carries. A role outside this set
// simply gets the neutral styling rather than `undefined` in the class list,
// which is what an `as Role` assertion used to hide.
const roleClassname: Record<string, string> = {
  Source: 'border-cobalt-500/40 text-cobalt-600',
  Destination: 'border-ink/25 text-ink/65',
  Enricher: 'border-ink/25 text-ink/65',
  Transformer: 'border-ink/25 text-ink/65',
  Processor: 'border-ink/25 text-ink/65',
}

/** The reference page an adapter card links to, relative to the channel root. */
function adapterRoute(adapter: AdapterRow): string {
  return `reference/adapters/${slug(adapter.name)}`
}

/**
 * Right-sidebar "On this page" sections for the adapter grid. The
 * component renders no markdown headings, so `collectSections` cannot
 * derive the page outline from the AST; this mirrors the rendered
 * structure (category header ids, per-adapter card ids) instead.
 */
export function adapterGridTocSections(
  channel: DocsChannelName = 'latest',
): Array<Section> {
  const visible = adapters(channel)
  return categories
    .map((category) => ({
      level: 2 as const,
      id: `adapters-${slug(category)}`,
      title: category as string,
      children: visible
        .filter((a) => a.category === category)
        .map((adapter) => ({
          level: 3 as const,
          id: `adapter-${slug(adapter.name)}`,
          title: adapter.name,
        })),
    }))
    .filter((section) => section.children.length > 0)
}

export function AdapterGrid({ channel = 'latest' }: DocsChannelProps) {
  const visible = adapters(channel)
  const channelPrefix = docsChannelHref(channel)

  return (
    <div className="not-prose mt-8 flex flex-col gap-14">
      {categories.map((category) => {
        const items = visible.filter((a) => a.category === category)
        if (items.length === 0) return null
        return (
          <section
            key={category}
            aria-labelledby={`adapters-${slug(category)}`}
          >
            <header className="flex items-center gap-3 border-b border-ink/15 pb-3">
              <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
              <h3
                id={`adapters-${slug(category)}`}
                className="scroll-mt-28 font-mono text-[0.65rem] tracking-[0.22em] text-ink/65 uppercase lg:scroll-mt-34"
              >
                {category}
              </h3>
              <span className="ml-auto font-mono text-[0.65rem] tracking-[0.22em] text-ink/45 tabular-nums">
                {String(items.length).padStart(2, '0')}
              </span>
            </header>
            <ul
              role="list"
              className="mt-5 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 sm:grid-cols-2 lg:grid-cols-3"
            >
              {items.map((item) => (
                <li
                  key={item.name}
                  id={`adapter-${slug(item.name)}`}
                  className="scroll-mt-28 bg-paper lg:scroll-mt-34"
                >
                  <Link
                    href={withDocsChannel(
                      `/docs/${adapterRoute(item)}`,
                      channelPrefix,
                    )}
                    className="group flex h-full flex-col gap-3 p-5 transition hover:bg-paper-deep/40"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <code className="font-mono text-[0.95rem] font-medium text-ink transition group-hover:text-cobalt-500">
                        {item.name}
                        <span className="text-ink/40">()</span>
                      </code>
                      <span
                        aria-hidden="true"
                        className="font-mono text-[0.9rem] text-ink/30 transition group-hover:translate-x-0.5 group-hover:text-cobalt-500"
                      >
                        →
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {item.roles.map((role) => (
                        <span
                          key={role}
                          className={
                            'inline-flex items-center border px-1.5 py-0.5 font-mono text-[0.6rem] tracking-[0.16em] uppercase ' +
                            (roleClassname[role] ?? roleClassname.Destination)
                          }
                        >
                          {role}
                        </span>
                      ))}
                    </div>
                    <p className="text-[0.9rem] leading-[1.55] text-ink/70">
                      {item.description}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
