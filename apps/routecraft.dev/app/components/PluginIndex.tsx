import { AppLink } from '@/components/AppLink'

import { slug } from '@/lib/slug'

import { type PluginRow, plugins } from '@/lib/docs-catalogue'
import {
  type DocsChannelName,
  type DocsChannelProps,
  docsChannelHref,
  withDocsChannel,
} from '@/lib/docs-channel'
import { type Section } from '@/lib/sections'

/** The reference page a plugin row links to, relative to the channel root. */
function pluginRoute(plugin: PluginRow): string {
  return `reference/plugins/${slug(plugin.name)}`
}

/**
 * Right-sidebar "On this page" sections for the plugin index. The
 * component renders no markdown headings, so `collectSections` cannot
 * derive the page outline from the AST; this mirrors the rendered
 * per-plugin row ids instead.
 */
export function pluginIndexTocSections(
  channel: DocsChannelName = 'latest',
): Array<Section> {
  return plugins(channel).map((p) => ({
    level: 2 as const,
    id: `plugin-${slug(p.name)}`,
    title: p.name,
    children: [],
  }))
}

export function PluginIndex({ channel = 'latest' }: DocsChannelProps) {
  const channelPrefix = docsChannelHref(channel)

  return (
    <ol className="not-prose mt-8 list-none">
      {plugins(channel).map((p, i) => (
        <li
          key={p.name}
          id={`plugin-${slug(p.name)}`}
          className={
            (i === 0 ? 'border-y border-ink/15' : 'border-b border-ink/15') +
            ' scroll-mt-28 lg:scroll-mt-34'
          }
        >
          <AppLink
            href={withDocsChannel(`/docs/${pluginRoute(p)}`, channelPrefix)}
            className="group grid grid-cols-[auto_1fr_auto] items-baseline gap-x-6 py-7 transition"
          >
            <span className="font-editorial text-[1.5rem] text-cobalt-500/55 italic tabular-nums transition group-hover:text-cobalt-500">
              {p.number}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-4">
                <code className="font-mono text-[1.05rem] text-ink transition group-hover:text-cobalt-500">
                  {p.name}
                </code>
                <span className="font-editorial text-[0.95rem] text-ink/45 italic">
                  {p.hint}
                </span>
                <span className="font-mono text-[0.65rem] tracking-[0.2em] text-ink/40 uppercase">
                  {p.module}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-[1rem] leading-[1.7] text-ink/70">
                {p.description}
              </p>
            </div>
            <span
              aria-hidden="true"
              className="self-center font-mono text-[1.1rem] text-ink/30 transition group-hover:translate-x-1 group-hover:text-cobalt-500"
            >
              →
            </span>
          </AppLink>
        </li>
      ))}
    </ol>
  )
}
