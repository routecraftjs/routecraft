import { AppLink } from '@/components/AppLink'

import { type OperationRow, operations } from '@/lib/docs-catalogue'
import {
  type DocsChannelName,
  type DocsChannelProps,
  docsChannelHref,
  withDocsChannel,
} from '@/lib/docs-channel'
import { type Section } from '@/lib/sections'
import { slug } from '@/lib/slug'

const categories = [
  'Route',
  'Wrapper',
  'Transform',
  'Flow Control',
  'Side Effects',
] as const

/** The reference page an operation row links to, relative to the channel root. */
function opRoute(op: OperationRow): string {
  return `reference/operations/${slug(op.name)}`
}

/**
 * Right-sidebar "On this page" sections for the operations index. The
 * component renders no markdown headings, so `collectSections` cannot
 * derive the page outline from the AST; this mirrors the rendered
 * structure (category header ids, per-operation row ids) instead.
 */
export function operationsTocSections(
  channel: DocsChannelName = 'latest',
): Array<Section> {
  const visible = operations(channel)
  return categories
    .map((category) => ({
      level: 2 as const,
      id: `ops-${slug(category)}`,
      title: category as string,
      children: visible
        .filter((o) => o.category === category)
        .map((op) => ({
          level: 3 as const,
          id: `op-${slug(op.name)}`,
          title: op.name,
          ...(op.planned
            ? { badges: [{ text: 'planned', color: 'purple' as const }] }
            : {}),
        })),
    }))
    .filter((section) => section.children.length > 0)
}

export function OperationsIndex({ channel = 'latest' }: DocsChannelProps) {
  const visible = operations(channel)
  const channelPrefix = docsChannelHref(channel)

  return (
    <div className="not-prose mt-8 flex flex-col gap-14">
      {categories.map((category) => {
        const items = visible.filter((o) => o.category === category)
        if (items.length === 0) return null
        return (
          <section key={category} aria-labelledby={`ops-${slug(category)}`}>
            <header className="flex items-center gap-3 border-b border-ink/15 pb-3">
              <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
              <h3
                id={`ops-${slug(category)}`}
                className="scroll-mt-28 font-mono text-[0.65rem] tracking-[0.22em] text-ink/65 uppercase lg:scroll-mt-34"
              >
                {category}
              </h3>
              <span className="ml-auto font-mono text-[0.65rem] tracking-[0.22em] text-ink/45 tabular-nums">
                {String(items.length).padStart(2, '0')}
              </span>
            </header>
            <ul role="list" className="divide-y divide-ink/10">
              {items.map((op) => (
                <li
                  key={op.name}
                  id={`op-${slug(op.name)}`}
                  className="scroll-mt-28 lg:scroll-mt-34"
                >
                  <AppLink
                    href={withDocsChannel(
                      `/docs/${opRoute(op)}`,
                      channelPrefix,
                    )}
                    className="group grid grid-cols-[minmax(0,16rem)_1fr_auto] items-baseline gap-x-6 gap-y-1 py-3.5 transition hover:bg-paper-deep/30"
                  >
                    <code className="font-mono text-[0.92rem] text-ink transition group-hover:text-cobalt-500">
                      {op.signature}
                    </code>
                    <p className="text-[0.92rem] leading-[1.55] text-ink/65">
                      {op.description}
                    </p>
                    <span className="flex items-center gap-3">
                      {op.planned && (
                        <span className="inline-flex items-center border border-cobalt-500/40 px-1.5 py-0.5 font-mono text-[0.55rem] tracking-[0.18em] text-cobalt-600 uppercase">
                          Planned
                        </span>
                      )}
                      <span
                        aria-hidden="true"
                        className="font-mono text-[0.9rem] text-ink/30 transition group-hover:translate-x-0.5 group-hover:text-cobalt-500"
                      >
                        →
                      </span>
                    </span>
                  </AppLink>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
