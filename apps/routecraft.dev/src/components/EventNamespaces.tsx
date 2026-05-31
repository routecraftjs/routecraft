interface NamespaceGroup {
  pattern: string
  events: string[]
  anchor: string
  note?: string
}

const groups: NamespaceGroup[] = [
  {
    pattern: 'context:*',
    events: ['starting', 'started', 'stopping', 'stopped'],
    anchor: 'context-events',
  },
  {
    pattern: 'route:*',
    events: ['registered', 'starting', 'started', 'stopping', 'stopped'],
    anchor: 'route-events',
  },
  {
    pattern: 'route:{routeId}:exchange:*',
    events: ['started', 'completed', 'failed', 'dropped', 'restored'],
    anchor: 'exchange-events',
  },
  {
    pattern: 'route:{routeId}:op:*',
    events: [
      'adapter',
      'batch',
      'split',
      'aggregate',
      'retry',
      'choice',
      'error',
      'agent',
      'source:parse',
    ],
    anchor: 'operation-events',
    note: 'Each operation emits its own started / completed / failed.',
  },
  {
    pattern: 'plugin:{pluginId}:*',
    events: ['registered', 'starting', 'started', 'stopping', 'stopped'],
    anchor: 'plugin-events',
  },
  {
    pattern: 'auth:*',
    events: ['success', 'rejected'],
    anchor: 'authentication-events',
  },
  {
    pattern: 'plugin:mcp:*',
    events: ['server', 'session', 'tool'],
    anchor: 'mcp-plugin-events',
    note: 'server (listening, tools:exposed), session (created, closed), tool (called, completed, failed).',
  },
]

export function EventNamespaces() {
  const total = groups.reduce((n, g) => n + g.events.length, 0)
  return (
    <div className="not-prose mt-8 border border-ink/15 bg-paper-deep/30">
      <header className="flex items-center gap-3 border-b border-ink/15 px-5 py-3">
        <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
        <h3 className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/65 uppercase">
          Namespace map
        </h3>
        <span className="ml-auto font-mono text-[0.65rem] tracking-[0.22em] text-ink/45 tabular-nums">
          {total} events / {groups.length} namespaces
        </span>
      </header>
      <ul role="list" className="divide-y divide-ink/10">
        {groups.map((g) => (
          <li key={g.pattern} className="px-5 py-4">
            <div className="flex items-baseline gap-3">
              <a
                href={`#${g.anchor}`}
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
