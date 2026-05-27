import Link from 'next/link'

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
]

export function PluginIndex() {
  return (
    <ol className="not-prose mt-8 list-none">
      {plugins.map((p, i) => (
        <li
          key={p.name}
          className={
            i === 0
              ? 'border-y border-ink/15 dark:border-paper/15'
              : 'border-b border-ink/15 dark:border-paper/15'
          }
        >
          <Link
            href={`/docs/reference/plugins/${p.name.toLowerCase()}`}
            className="group grid grid-cols-[auto_1fr_auto] items-baseline gap-x-6 py-7 transition"
          >
            <span className="font-editorial text-[1.5rem] text-cobalt-500/55 italic tabular-nums transition group-hover:text-cobalt-500">
              {p.number}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-4">
                <code className="font-mono text-[1.05rem] text-ink transition group-hover:text-cobalt-500 dark:text-paper dark:group-hover:text-cobalt-300">
                  {p.name}
                </code>
                <span className="font-editorial text-[0.95rem] text-ink/45 italic dark:text-paper/45">
                  {p.hint}
                </span>
                <span className="font-mono text-[0.65rem] tracking-[0.2em] text-ink/40 uppercase dark:text-paper/40">
                  {p.module}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-[1rem] leading-[1.7] text-ink/70 dark:text-paper/70">
                {p.description}
              </p>
            </div>
            <span
              aria-hidden="true"
              className="self-center font-mono text-[1.1rem] text-ink/30 transition group-hover:translate-x-1 group-hover:text-cobalt-500 dark:text-paper/30"
            >
              →
            </span>
          </Link>
        </li>
      ))}
    </ol>
  )
}
