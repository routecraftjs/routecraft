import type { Metadata } from 'next'

import { CheatCode } from '@/components/CheatCode'
import {
  CheatLabel,
  CheatNote,
  CheatSection,
} from '@/components/CheatSection'
import { PrintButton } from '@/components/PrintButton'

export const metadata: Metadata = {
  title: 'Routecraft Cheat Sheet',
  description:
    'One-page reference for the Routecraft DSL: installation, sources, destinations, operations, validation, error handling, events, MCP integration, CLI, and TUI. Print-to-PDF ready.',
  openGraph: {
    title: 'Routecraft Cheat Sheet',
    description:
      'One-page reference for the Routecraft DSL. Filter, validate, transform, enrich, split, aggregate, MCP integration, CLI. Print to PDF.',
    type: 'website',
  },
}

export default function CheatSheetPage() {
  return (
    <main className="w-full pb-16 print:pb-0">
      <section className="border-b border-gray-200 bg-linear-to-br from-sky-50 via-white to-white print:border-0 print:bg-transparent dark:border-gray-800 dark:from-sky-950/40 dark:via-gray-950 dark:to-gray-950">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8 print:px-0 print:py-2">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="flex-1">
              <p className="font-display text-xs font-medium text-sky-500">
                Reference
              </p>
              <h1 className="mt-1 font-display text-3xl font-medium tracking-tight text-gray-900 sm:text-4xl dark:text-white">
                Routecraft Cheat Sheet
              </h1>
              <p className="mt-3 max-w-3xl text-sm text-gray-600 sm:text-base dark:text-gray-400">
                AI automation as code. The whole fluent API on one page.
                Searchable, copyable, and print-to-PDF ready.
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-sky-50 px-2.5 py-1 font-medium text-sky-700 ring-1 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30">
                  v0.5.0
                </span>
                <span className="rounded-full bg-gray-100 px-2.5 py-1 font-medium text-gray-700 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-700">
                  TypeScript
                </span>
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 print:hidden">
              <PrintButton />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Or press{' '}
                <kbd className="rounded border border-gray-300 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.7rem] dark:border-gray-700 dark:bg-gray-800">
                  Cmd/Ctrl + P
                </kbd>
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-7xl px-4 pt-8 sm:px-6 lg:px-8 print:px-0 print:pt-2">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3 print:grid-cols-2 print:gap-3">
          <CheatSection eyebrow="Setup" title="Installation">
            <CheatCode language="bash">{`# Core library
bun add @routecraft/routecraft

# AI / MCP integration
bun add @routecraft/ai

# CLI (run routes from the terminal)
bun add -g @routecraft/cli`}</CheatCode>
            <CheatNote>
              CLI runs TypeScript directly via Bun (Bun &gt;= 1.1.0). Node 22+
              also works.
            </CheatNote>
          </CheatSection>

        <CheatSection eyebrow="Concept" title="Route + Context">
          <CheatCode>{`import { craft, ContextBuilder } from '@routecraft/routecraft'

const route = craft()
  .id('my-route')
  .from(source)
  .transform(x => x.body)
  .to(destination)
  .build()

const ctx = await new ContextBuilder()
  .routes(route)
  .build()

await ctx.start()
await ctx.stop()`}</CheatCode>
        </CheatSection>

        <CheatSection
          eyebrow="DSL"
          title="Builder DSL (fluent API)"
          span="wide"
        >
          <p>Chain operations to build a type-safe pipeline. Types flow through each step.</p>
          <CheatCode>{`craft()
  .id('pipeline')                  // unique route name
  .description('...')              // doc string used in errors
  .input({ size: 100 })            // optional input schema
  .from(source)                    // source adapter
  .transform(body => body)         // pure body function
  .process(ex => ex)               // full exchange access
  .filter(ex => ex.body.age > 18)  // drop if false
  .validate(schema(zodSchema))     // any Standard Schema
  .header('key', 'val')            // set a header
  .enrich(other)                   // fetch and merge
  .split()                         // fan-out per array item
  .aggregate()                     // collect back into one
  .to(destination)                 // destination adapter
  .build()`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Inputs" title="Sources">
          <CheatCode>{`// Static value or async function
.from(simple({ hello: 'world' }))
.from(simple(() => fetch('/api')))

// Emit on an interval
.from(timer({ intervalMs: 5000 }))

// Cron schedule
.from(cron('0 9 * * *'))
.from(cron('0 9 * * *',
  { timezone: 'UTC' }))

// In-process channel
.from(channel('name', { schema }))

// IMAP mail (push via IDLE)
.from(imap({ folder: 'INBOX',
  unseen: true }))

// File source
.from(file({ path: './data.json' }))`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Outputs" title="Destinations">
          <CheatCode>{`// Log to console
.to(log())
.to(debug(ex => ex.body))

// HTTP request
.to(http({
  method: 'POST',
  url: 'https://example.com',
  body: ex => ex.body,
}))

// Dynamic URL
.to(http({ url: ex => \`/\${ex.body.id}\` }))

// In-process channel
.to(channel('my-channel'))

// Write file (mode: 'append' or 'write')
.to(file({ path: './out.txt',
  mode: 'append' }))

// Send email via SMTP
.to(smtp({
  to: ex => ex.body.email,
  subject: 'Hello',
}))`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Envelope" title="Exchanges">
          <CheatCode>{`type Exchange<T> = {
  id: string
  body: T
  headers: ExchangeHeaders
  logger: Logger
}`}</CheatCode>
          <CheatLabel>Access patterns</CheatLabel>
          <CheatCode>{`// .transform() gets the body
.transform(body => body.toUpperCase())

// .process() gets the full exchange
.process(ex => ({
  ...ex,
  body: { ...ex.body, ts: Date.now() },
}))

// .filter() gets the full exchange
.filter(ex => ex.body.age > 18)`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Flow" title="Split &amp; aggregate">
          <p>Fan out an array, process each item, collect back.</p>
          <CheatCode>{`craft()
  .from(simple([1, 2, 3]))
  .split()                  // 3 exchanges
  .transform(n => n * 2)    // each runs once
  .aggregate()              // [2, 4, 6]
  .to(log())`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Lookup" title="Enrich (fetch &amp; merge)">
          <CheatCode>{`// Default: deep merge
.enrich(http({ url: '/api/user' }))

// Custom merge strategy
.enrich(dest, (orig, fetched) => ({
  ...orig.body,
  meta: fetched.body,
}))

// Merge helpers
.enrich(dest, only('meta'))
.enrich(dest, replace())`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Safety" title="Validation (Standard Schema)">
          <p>Works with Zod, Valibot, ArkType, or any Standard Schema library.</p>
          <CheatCode>{`import { z } from 'zod'
import { schema } from '@routecraft/routecraft'

craft()
  .from(channel('input'))
  .validate(schema(z.object({
    email: z.string().email(),
    age: z.number().min(18),
  })))
  .to(log())
// body type is inferred from the schema`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Observability" title="Events system">
          <CheatCode>{`// Lifecycle
ctx.on('context:started', () => {})
ctx.on('context:error', (err) => {})

// Route lifecycle
ctx.on('route:started', () => {})

// Exchange tracking
ctx.on('route:exchange:completed',
  ({ details }) => {
    // { exchange, duration }
  })

// Step-level tracing
ctx.on('step:completed', ({ details }) => {
  // { operation, adapter, duration }
})

// Wildcards (glob)
ctx.on('route:**', () => {})`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Recovery" title="Error handling">
          <CheatCode>{`craft()
  .error((error, exchange, forward) => {
    // Return a recovery value
    return { recovered: true }

    // Or forward to a dead-letter route
    return forward('dlq', {
      source: error.message,
    })
  })
  .from(source)
  .to(destination)`}</CheatCode>
          <CheatLabel>Error code ranges</CheatLabel>
          <CheatCode language="text">{`RC1xxx  Definition
RC2xxx  DSL
RC3xxx  Runtime
RC4xxx  Lifecycle
RC5xxx  Adapter`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Runtime" title="Context &amp; plugins">
          <CheatCode>{`const ctx = await new ContextBuilder()
  .add({
    crm: { timezone: 'UTC' },
    direct: { channelType: 'memory' },
    mail: { accounts: { /* ... */ } },
    plugins: [myPlugin],
  })
  .on('context:started', () => {})
  .store('custom-key', value)
  .routes(route1, route2)
  .build()

const myPlugin: CraftPlugin = {
  async apply(ctx) {
    ctx.store('key', new Map())
  },
  async teardown(ctx) { /* cleanup */ },
}`}</CheatCode>
        </CheatSection>

        <CheatSection
          eyebrow="AI"
          title="MCP integration"
          span="wide"
        >
          <CheatLabel>Expose a route as an MCP tool</CheatLabel>
          <CheatCode>{`import { mcp } from '@routecraft/ai'

craft()
  .id('fetch-page')
  .from(mcp({
    name: 'fetch-page',
    description: 'Fetch webpage content',
    schema: z.object({ url: z.string().url() }),
  }))
  .enrich(http({ url: ex => ex.body.url }))
  .to(log())`}</CheatCode>
          <CheatLabel>Call an LLM inside a route</CheatLabel>
          <CheatCode>{`import { llm } from '@routecraft/ai'

craft()
  .id('summarize')
  .from(channel('text-in'))
  .to(llm({
    systemPrompt: 'Summarize concisely',
    userPrompt: ex => ex.body.text,
  }))
  .to(log())`}</CheatCode>
          <CheatLabel>Claude Desktop config</CheatLabel>
          <CheatCode language="json">{`{
  "mcpServers": {
    "routecraft": {
      "command": "bunx",
      "args": ["@routecraft/cli", "run",
        "./capabilities/index.ts"]
    }
  }
}`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Terminal" title="CLI">
          <CheatCode language="bash">{`# Run a route file
craft run ./my-route.ts

# With debug logging
craft run ./my-route.ts \\
  --log-level debug \\
  --log-file ./craft.log`}</CheatCode>
          <CheatLabel>Common patterns</CheatLabel>
          <CheatCode>{`// Scheduled fetch and notify
craft()
  .from(cron('0 9 * * *'))
  .enrich(http({ url: '/api/...' }))
  .to(smtp({ to: 'team@example.com' }))

// Webhook fan-out
craft()
  .from(channel('webhook'))
  .split()
  .enrich(http({ url: ex => \`/\${ex.body.id}\` }))
  .to(smtp({ to: ex => ex.body.email }))`}</CheatCode>
        </CheatSection>

        <CheatSection eyebrow="Debug" title="Terminal UI (TUI)">
          <p>
            Inspect routes, exchanges, and live events. Requires the telemetry
            plugin enabled on the context.
          </p>
          <CheatCode language="bash">{`# Launch the TUI (reads the telemetry DB)
craft tui

# Or point it at a specific DB
craft tui --db ./app/telemetry.db`}</CheatCode>
        </CheatSection>

        <CheatSection
          eyebrow="Snippets"
          title="Quick reference"
          span="wide"
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[0.78rem]">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  <th className="py-1.5 pr-3 font-medium">Task</th>
                  <th className="py-1.5 font-medium">Code</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {[
                  ['Every minute', `cron('* * * * *')`],
                  ['Daily at 9 AM', `cron('0 9 * * *', { timezone: 'UTC' })`],
                  ['Filter', `.filter(ex => ex.body.age > 18)`],
                  ['Split an array', `.split()`],
                  ['Collect results', `.aggregate()`],
                  ['Validate body', `.validate(schema(z.object({ ... })))`],
                  ['Dynamic URL', `http({ url: ex => \`/users/\${ex.body.id}\` })`],
                  ['Set header', `.header('key', ex => ex.body.id)`],
                  ['Side effect', `.tap(destination)`],
                  ['Forward error', `.error((e, ex, fwd) => fwd('dlq'))`],
                ].map(([task, code]) => (
                  <tr
                    key={task}
                    className="border-b border-gray-100 last:border-0 dark:border-gray-800/60"
                  >
                    <td className="py-1.5 pr-3 font-sans text-gray-600 dark:text-gray-300">
                      {task}
                    </td>
                    <td className="py-1.5 text-gray-800 dark:text-gray-200">
                      {code}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CheatSection>
      </div>

        <footer className="mt-10 flex flex-col items-center gap-2 border-t border-gray-200 pt-6 text-xs text-gray-500 print:mt-6 print:border-gray-300 print:pt-3 dark:border-gray-800 dark:text-gray-400">
          <p>
            Routecraft &middot; AI automation as code &middot;{' '}
            <a
              href="https://routecraft.dev"
              className="font-medium text-sky-600 dark:text-sky-400"
            >
              routecraft.dev
            </a>{' '}
            &middot;{' '}
            <a
              href="https://github.com/routecraftjs/routecraft"
              className="font-medium text-sky-600 dark:text-sky-400"
            >
              GitHub
            </a>
          </p>
        </footer>
      </div>
    </main>
  )
}
