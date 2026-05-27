import Link from 'next/link'

interface Column {
  label: string
  count: number
  items: { name: string; href: string }[]
}

function ref(name: string) {
  return { name, href: `/docs/reference/adapters/${name.toLowerCase()}` }
}

const columns: Column[] = [
  {
    label: 'Sources',
    count: 8,
    items: [
      ref('cron'),
      ref('http'),
      ref('mcp'),
      ref('mail'),
      ref('file'),
      ref('direct'),
      ref('simple'),
      ref('timer'),
    ],
  },
  {
    label: 'Destinations',
    count: 8,
    items: [
      ref('mail'),
      ref('file'),
      ref('log'),
      ref('agent'),
      ref('direct'),
      ref('http'),
      ref('noop'),
      ref('debug'),
    ],
  },
  {
    label: 'Transformers',
    count: 6,
    items: [
      ref('json'),
      ref('csv'),
      ref('jsonl'),
      ref('html'),
      ref('group'),
      ref('cosine'),
    ],
  },
  {
    label: 'AI',
    count: 4,
    items: [ref('mcp'), ref('llm'), ref('agent'), ref('embedding')],
  },
  {
    label: 'Testing',
    count: 3,
    items: [ref('noop'), ref('spy'), ref('pseudo')],
  },
]

export function HomeAdapters() {
  return (
    <section>
      <div className="mx-auto max-w-7xl px-4 pt-12 pb-20 sm:px-6 lg:px-8 lg:pt-14 lg:pb-24">
        <header className="max-w-3xl">
          <h2
            className="font-editorial text-[2.5rem] leading-[1.05] tracking-[-0.02em] text-ink dark:text-paper"
            style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30' }}
          >
            The{' '}
            <span
              className="text-cobalt-500 italic"
              style={{ fontVariationSettings: '"opsz" 144, "SOFT" 100' }}
            >
              surface area.
            </span>
          </h2>
          <p className="mt-4 max-w-2xl text-[1rem] leading-[1.7] text-ink/65 dark:text-paper/65">
            Every adapter in Routecraft, grouped by what they do. Click any name
            for the full signature, options, and examples. New adapters are
            built the same way as built-ins.
          </p>
        </header>

        <div className="mt-12 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 sm:grid-cols-2 lg:grid-cols-5 dark:border-paper/15 dark:bg-paper/15">
          {columns.map((col) => (
            <div
              key={col.label}
              className="flex flex-col bg-paper p-5 dark:bg-ink"
            >
              <header className="flex items-baseline justify-between gap-2 border-b border-ink/15 pb-3 dark:border-paper/15">
                <h3 className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/65 uppercase dark:text-paper/65">
                  {col.label}
                </h3>
                <span className="font-mono text-[0.6rem] tracking-[0.22em] text-ink/40 tabular-nums dark:text-paper/40">
                  {String(col.count).padStart(2, '0')}
                </span>
              </header>
              <ul role="list" className="mt-3 flex flex-col gap-1">
                {col.items.map((item) => (
                  <li key={`${col.label}-${item.name}`}>
                    <Link
                      href={item.href}
                      className="group flex items-baseline justify-between gap-2 py-1.5 transition"
                    >
                      <code className="font-mono text-[0.92rem] text-ink transition group-hover:text-cobalt-500 dark:text-paper dark:group-hover:text-cobalt-300">
                        {item.name}
                        <span className="text-ink/35 dark:text-paper/35">
                          ()
                        </span>
                      </code>
                      <span
                        aria-hidden="true"
                        className="font-mono text-[0.8rem] text-ink/25 opacity-0 transition group-hover:translate-x-0.5 group-hover:text-cobalt-500 group-hover:opacity-100 dark:text-paper/25"
                      >
                        →
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-6 max-w-2xl text-[0.95rem] text-ink/60 italic dark:text-paper/60">
          <span className="font-editorial">
            Need something that isn&apos;t here? Adapters are a documented,
            stable contract,{' '}
          </span>
          <Link
            href="/docs/advanced/custom-adapters"
            className="border-b border-current pb-px font-editorial text-cobalt-500 hover:text-cobalt-600 dark:hover:text-cobalt-300"
          >
            write your own
          </Link>
          <span className="font-editorial">.</span>
        </p>
      </div>
    </section>
  )
}
