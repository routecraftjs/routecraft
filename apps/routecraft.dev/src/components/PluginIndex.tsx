import Link from 'next/link'

import { slug } from '@/lib/slug'

import { documentsPage } from '@/lib/docs-catalogue'
import {
  type DocsChannelName,
  docsChannelHref,
  withDocsChannel,
} from '@/lib/docs-channel'
import { type Section } from '@/lib/sections'

interface Plugin {
  number: string
  name: string
  module: string
  hint: string
  description: string
}

const plugins: Plugin[] = [
  {
    number: '01',
    name: 'llmPlugin',
    module: '@routecraft/ai',
    hint: 'Language models.',
    description:
      'Configure provider keys, default models, and global LLM defaults for every agent and llm() call in the context.',
  },
  {
    number: '02',
    name: 'embeddingPlugin',
    module: '@routecraft/ai',
    hint: 'Vectors.',
    description:
      'Wire an embedding provider for the embedding() destination and downstream clustering with cosine().',
  },
  {
    number: '03',
    name: 'mcpPlugin',
    module: '@routecraft/ai',
    hint: 'MCP server runtime.',
    description:
      'Expose mcp() capabilities over Model Context Protocol, with JWT, OAuth 2.1, and bearer-token verification built in.',
  },
  {
    number: '04',
    name: 'agentPlugin',
    module: '@routecraft/ai',
    hint: 'Agent registry and harness.',
    description:
      'Register named agents, the tools they can call, and shared defaults like system prompt and principal context.',
  },
  {
    number: '05',
    name: 'httpPlugin',
    module: '@routecraft/routecraft',
    hint: 'HTTP server runtime.',
    description:
      'Expose routes over HTTP via the http() source. Bun.serve native on Bun, node:http shim on Node; JWT, JWKS, or API-key auth at the plugin boundary.',
  },
]

/** The reference page a plugin row links to, relative to the channel root. */
function pluginRoute(plugin: Plugin): string {
  return `reference/plugins/${slug(plugin.name)}`
}

/**
 * The plugins this channel documents. `plugins` ships with the site shell,
 * which always builds from main, while /docs is frozen to the last released
 * tag: a plugin that only exists on main would otherwise be listed as released
 * and link to a page the released channel does not carry.
 */
function channelPlugins(channel: DocsChannelName): Array<Plugin> {
  return plugins.filter((plugin) => documentsPage(channel, pluginRoute(plugin)))
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
  return channelPlugins(channel).map((p) => ({
    level: 2 as const,
    id: `plugin-${slug(p.name)}`,
    title: p.name,
    children: [],
  }))
}

export function PluginIndex({
  channel = 'latest',
}: {
  channel?: DocsChannelName
}) {
  const channelPrefix = docsChannelHref(channel)

  return (
    <ol className="not-prose mt-8 list-none">
      {channelPlugins(channel).map((p, i) => (
        <li
          key={p.name}
          id={`plugin-${slug(p.name)}`}
          className={
            (i === 0 ? 'border-y border-ink/15' : 'border-b border-ink/15') +
            ' scroll-mt-28 lg:scroll-mt-34'
          }
        >
          <Link
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
          </Link>
        </li>
      ))}
    </ol>
  )
}
