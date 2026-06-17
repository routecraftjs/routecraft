import Link from 'next/link'

import { type Section } from '@/lib/sections'
import { slug } from '@/lib/slug'

type Role = 'Source' | 'Destination' | 'Transformer' | 'Processor'

interface Adapter {
  name: string
  category: string
  roles: Role[]
  description: string
}

const adapters: Adapter[] = [
  // Core
  {
    name: 'simple',
    category: 'Core',
    roles: ['Source'],
    description: 'Static or dynamic data source from a value or function.',
  },
  {
    name: 'log',
    category: 'Core',
    roles: ['Destination'],
    description: 'Console logging for debugging and inspection.',
  },
  {
    name: 'debug',
    category: 'Core',
    roles: ['Destination'],
    description: 'Verbose dump of the full exchange for development.',
  },
  {
    name: 'timer',
    category: 'Core',
    roles: ['Source'],
    description: 'Recurring source on a fixed interval.',
  },
  {
    name: 'cron',
    category: 'Core',
    roles: ['Source'],
    description: 'Cron-scheduled source with timezone support.',
  },
  {
    name: 'event',
    category: 'Core',
    roles: ['Source'],
    description: 'Internal event bus source for cross-route signalling.',
  },
  {
    name: 'direct',
    category: 'Core',
    roles: ['Source', 'Destination'],
    description: 'Synchronous route-to-route plumbing with type safety.',
  },
  {
    name: 'http',
    category: 'Core',
    roles: ['Source', 'Destination'],
    description:
      'HTTP client for outbound requests and an HTTP server (via defineConfig({ http })) for exposing routes.',
  },

  // Test
  {
    name: 'noop',
    category: 'Test',
    roles: ['Destination'],
    description: 'Discards the exchange. Useful for benchmarks and stubs.',
  },
  {
    name: 'pseudo',
    category: 'Test',
    roles: ['Source', 'Destination', 'Processor'],
    description: 'Typed placeholder for docs, examples, and test wiring.',
  },
  {
    name: 'spy',
    category: 'Test',
    roles: ['Destination', 'Processor'],
    description: 'Records exchanges and exposes them for test assertions.',
  },

  // File
  {
    name: 'file',
    category: 'File',
    roles: ['Source', 'Destination'],
    description: 'Read or write a single text file (per-line chunked reads).',
  },
  {
    name: 'folder',
    category: 'File',
    roles: ['Source'],
    description:
      'Scan a directory for files, with metadata to filter on; list or per-file.',
  },
  {
    name: 'json',
    category: 'File',
    roles: ['Source', 'Destination', 'Transformer'],
    description: 'Parse, write, or transform JSON files.',
  },
  {
    name: 'csv',
    category: 'File',
    roles: ['Source', 'Destination'],
    description: 'Stream rows from a CSV file or write rows out.',
  },
  {
    name: 'jsonl',
    category: 'File',
    roles: ['Source', 'Destination'],
    description: 'Stream JSON Lines records or append to a JSONL file.',
  },
  {
    name: 'html',
    category: 'File',
    roles: ['Source', 'Destination', 'Transformer'],
    description: 'Parse or write HTML, with DOM-style selection helpers.',
  },

  // Messaging
  {
    name: 'mail',
    category: 'Messaging',
    roles: ['Source', 'Destination'],
    description: 'Receive email via IMAP or send via SMTP.',
  },

  // Contacts
  {
    name: 'carddav',
    category: 'Contacts',
    roles: ['Source', 'Destination'],
    description:
      'Read and write contacts over CardDAV. Defaults to Apple iCloud Contacts; works with any CardDAV server.',
  },

  // Browser
  {
    name: 'agentBrowser',
    category: 'Browser',
    roles: ['Destination'],
    description: 'Drive a real browser session: navigate, click, snapshot.',
  },

  // AI
  {
    name: 'mcp',
    category: 'AI',
    roles: ['Source', 'Destination'],
    description: 'Expose capabilities as MCP tools or call remote MCP servers.',
  },
  {
    name: 'llm',
    category: 'AI',
    roles: ['Destination'],
    description: 'Call a language model for text or structured output.',
  },
  {
    name: 'agent',
    category: 'AI',
    roles: ['Destination'],
    description: 'Run an LLM with a fixed system prompt and tool set.',
  },
  {
    name: 'embedding',
    category: 'AI',
    roles: ['Destination'],
    description: 'Generate vector embeddings from text.',
  },

  // Clustering
  {
    name: 'group',
    category: 'Clustering',
    roles: ['Transformer'],
    description: 'Group exchanges into batches by key, count, or time.',
  },
  {
    name: 'cosine',
    category: 'Clustering',
    roles: ['Transformer'],
    description: 'Cluster items by cosine similarity of embeddings.',
  },
]

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

const roleClassname: Record<Role, string> = {
  Source: 'border-cobalt-500/40 text-cobalt-600',
  Destination: 'border-ink/25 text-ink/65',
  Transformer: 'border-ink/25 text-ink/65',
  Processor: 'border-ink/25 text-ink/65',
}

/**
 * Right-sidebar "On this page" sections for the adapter grid. The
 * component renders no markdown headings, so `collectSections` cannot
 * derive the page outline from the AST; this mirrors the rendered
 * structure (category header ids, per-adapter card ids) instead.
 */
export function adapterGridTocSections(): Array<Section> {
  return categories
    .map((category) => ({
      level: 2 as const,
      id: `adapters-${slug(category)}`,
      title: category as string,
      children: adapters
        .filter((a) => a.category === category)
        .map((adapter) => ({
          level: 3 as const,
          id: `adapter-${slug(adapter.name)}`,
          title: adapter.name,
        })),
    }))
    .filter((section) => section.children.length > 0)
}

export function AdapterGrid() {
  return (
    <div className="not-prose mt-8 flex flex-col gap-14">
      {categories.map((category) => {
        const items = adapters.filter((a) => a.category === category)
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
                    href={`/docs/reference/adapters/${slug(item.name)}`}
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
                            roleClassname[role]
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
