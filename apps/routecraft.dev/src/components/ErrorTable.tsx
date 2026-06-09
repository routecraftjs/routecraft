'use client'

import { useMemo, useState } from 'react'

type Category = 'Definition' | 'DSL' | 'Lifecycle' | 'Adapter' | 'Runtime'

interface ErrorRow {
  code: string
  category: Category
  message: string
  retryable: boolean
}

const errors: ErrorRow[] = [
  {
    code: 'RC1001',
    category: 'Definition',
    message: 'Route definition failed validation',
    retryable: false,
  },
  {
    code: 'RC1002',
    category: 'Definition',
    message: 'Duplicate route id',
    retryable: false,
  },
  {
    code: 'RC2001',
    category: 'DSL',
    message: 'Invalid operation type',
    retryable: false,
  },
  {
    code: 'RC2002',
    category: 'DSL',
    message: 'Missing from step',
    retryable: false,
  },
  {
    code: 'RC3001',
    category: 'Lifecycle',
    message: 'Route failed to start',
    retryable: false,
  },
  {
    code: 'RC3002',
    category: 'Lifecycle',
    message: 'Context failed to start',
    retryable: false,
  },
  {
    code: 'RC5001',
    category: 'Adapter',
    message: 'Step execution failed',
    retryable: true,
  },
  {
    code: 'RC5002',
    category: 'Adapter',
    message: 'Validation failed',
    retryable: false,
  },
  {
    code: 'RC5003',
    category: 'Adapter',
    message: 'Adapter misconfigured',
    retryable: false,
  },
  {
    code: 'RC5004',
    category: 'Adapter',
    message: 'No handler available',
    retryable: false,
  },
  {
    code: 'RC5010',
    category: 'Adapter',
    message: 'Connection failed',
    retryable: true,
  },
  {
    code: 'RC5011',
    category: 'Adapter',
    message: 'Request timeout',
    retryable: true,
  },
  {
    code: 'RC5012',
    category: 'Adapter',
    message: 'Authentication failed',
    retryable: false,
  },
  {
    code: 'RC5013',
    category: 'Adapter',
    message: 'Rate limited',
    retryable: true,
  },
  {
    code: 'RC5014',
    category: 'Adapter',
    message: 'Resource not found',
    retryable: false,
  },
  {
    code: 'RC5015',
    category: 'Adapter',
    message: 'Permission denied',
    retryable: false,
  },
  {
    code: 'RC5016',
    category: 'Adapter',
    message: 'Source payload parse failed',
    retryable: false,
  },
  {
    code: 'RC5017',
    category: 'Adapter',
    message: 'Optional peer dependency missing',
    retryable: false,
  },
  {
    code: 'RC5020',
    category: 'Adapter',
    message: 'Authorization failed: token expired during processing',
    retryable: false,
  },
  {
    code: 'RC5021',
    category: 'Adapter',
    message: 'Principal enrichment failed',
    retryable: false,
  },
  {
    code: 'RC5022',
    category: 'Adapter',
    message: 'Userinfo sub invariant violated',
    retryable: false,
  },
  {
    code: 'RC5023',
    category: 'Adapter',
    message: 'Authorization failed: principal is not authentic',
    retryable: false,
  },
  {
    code: 'RC5024',
    category: 'Adapter',
    message: 'authenticate() called without a subject',
    retryable: false,
  },
  {
    code: 'RC5025',
    category: 'Adapter',
    message: 'Agent block resolution failed',
    retryable: false,
  },
  {
    code: 'RC5026',
    category: 'Adapter',
    message: 'Agent block name collision',
    retryable: false,
  },
  {
    code: 'RC5027',
    category: 'Adapter',
    message: 'Agent block misconfigured',
    retryable: false,
  },
  {
    code: 'RC5028',
    category: 'Adapter',
    message: 'Cache provider failed',
    retryable: true,
  },
  {
    code: 'RC5029',
    category: 'Adapter',
    message: 'Cache key derivation failed',
    retryable: false,
  },
  {
    code: 'RC5030',
    category: 'Adapter',
    message: 'Resource changed (precondition failed)',
    retryable: false,
  },
  {
    code: 'RC9901',
    category: 'Runtime',
    message: 'Unknown error',
    retryable: true,
  },
]

const categories: ('All' | Category)[] = [
  'All',
  'Definition',
  'DSL',
  'Lifecycle',
  'Adapter',
  'Runtime',
]

export function ErrorTable() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'All' | Category>('All')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return errors.filter((e) => {
      if (category !== 'All' && e.category !== category) return false
      if (!q) return true
      return (
        e.code.toLowerCase().includes(q) ||
        e.message.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q)
      )
    })
  }, [query, category])

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
                      href={`#${e.code.toLowerCase()}`}
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
        Showing {filtered.length} of {errors.length} codes
      </p>
    </div>
  )
}
