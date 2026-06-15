import type { Metadata } from 'next'

import { CheatCode } from '@/components/CheatCode'
import { CheatLabel, CheatNote, CheatSection } from '@/components/CheatSection'
import { CheatSheetRail } from '@/components/CheatSheetRail'
import { PrintButton } from '@/components/PrintButton'
import { docVersion } from '@/lib/site'

const railItems = [
  { id: 'installation', title: 'Installation' },
  { id: 'route-context', title: 'Route + Context' },
  { id: 'builder-dsl-fluent-api', title: 'Builder DSL' },
  { id: 'sources', title: 'Sources' },
  { id: 'destinations', title: 'Destinations' },
  { id: 'exchanges', title: 'Exchanges' },
  { id: 'split-and-aggregate', title: 'Split & aggregate' },
  { id: 'choice-branching', title: 'Choice & branching' },
  { id: 'enrich-fetch-and-merge', title: 'Enrich' },
  { id: 'validation-standard-schema', title: 'Validation' },
  { id: 'events-system', title: 'Events system' },
  { id: 'error-handling', title: 'Error handling' },
  { id: 'context-and-plugins', title: 'Context & plugins' },
  { id: 'llm', title: 'LLM destination' },
  { id: 'agents', title: 'Agents & tools' },
  { id: 'mcp-integration', title: 'MCP integration' },
  { id: 'cli', title: 'CLI & TUI' },
]

export const metadata: Metadata = {
  title: 'Routecraft Cheat Sheet',
  description:
    'One-page reference for the Routecraft DSL: sources, destinations, operations, validation, errors, events, agents, MCP, CLI and TUI. Print-to-PDF ready.',
  alternates: { canonical: '/cheat-sheet/' },
  openGraph: {
    title: 'Routecraft Cheat Sheet',
    description:
      'One-page reference for the Routecraft DSL. Filter, validate, transform, enrich, split, aggregate, LLM, agents, MCP, CLI. Print to PDF.',
    url: '/cheat-sheet/',
    type: 'website',
  },
}

export default function CheatSheetPage() {
  return (
    <main className="w-full pb-16 print:pb-0">
      <section className="border-b border-ink/15 print:border-none">
        <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 sm:py-14 lg:px-8 print:px-0 print:py-2">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="flex-1">
              <p className="flex items-center gap-3 font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase">
                <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
                <span>Reference</span>
              </p>
              <h1 className="mt-6 font-editorial text-[clamp(2rem,4vw,3rem)] leading-[1.05] font-medium tracking-[-0.02em] text-ink">
                Routecraft{' '}
                <span className="text-cobalt-500 italic">cheat sheet.</span>
              </h1>
              <p className="mt-5 max-w-2xl font-editorial text-[1.05rem] leading-[1.55] text-ink/70 italic">
                The whole fluent API on one page. Searchable, copyable, and
                print-to-PDF ready.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-2 border border-cobalt-500/50 px-2.5 py-1 font-mono text-[0.65rem] tracking-[0.18em] text-cobalt-500 uppercase">
                  <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />v
                  {docVersion}
                </span>
                <span className="inline-flex items-center border border-ink/25 px-2.5 py-1 font-mono text-[0.65rem] tracking-[0.18em] text-ink/65 uppercase">
                  TypeScript
                </span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-3 text-right print:hidden">
              <PrintButton />
              <p className="font-mono text-[0.65rem] tracking-[0.18em] text-ink/55 uppercase">
                Or press{' '}
                <kbd className="ml-1 inline-flex items-center border border-ink/25 px-1.5 py-0.5 font-mono text-[0.65rem]">
                  Cmd/Ctrl + P
                </kbd>
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-7xl px-4 pt-8 sm:px-6 lg:flex lg:gap-10 lg:px-8 print:block print:px-0 print:pt-2">
        <aside className="hidden lg:block lg:w-44 lg:shrink-0 print:hidden">
          <CheatSheetRail items={railItems} />
        </aside>
        <div className="grid min-w-0 flex-1 grid-flow-row-dense auto-rows-min grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-2 print:grid-cols-2 print:gap-3">
          <CheatSection id="installation" eyebrow="Setup" title="Installation">
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

          <CheatSection
            id="route-context"
            eyebrow="Concept"
            title="Route + Context"
          >
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
            id="builder-dsl-fluent-api"
            eyebrow="DSL"
            title="Builder DSL (fluent API)"
            span="wide"
          >
            <p>
              Chain operations to build a type-safe pipeline. Types flow through
              each step.
            </p>
            <CheatCode>{`craft()
  .id('pipeline')                  // unique route name
  .title('Pipeline')               // display name (agents, docs)
  .description('...')              // doc string used in errors
  .tag('idempotent')               // route classification
  .input({ body: schema })         // input validation
  .output({ body: schema })        // output validation
  .authorize({ roles: ['admin'] }) // route guard (auth)
  .from(source)                    // source adapter
  .authenticate(resolver)          // mint trusted principal
  .transform(body => body)         // pure body function
  .process(ex => ex)               // full exchange access
  .filter(ex => ex.body.age > 18)  // drop if false
  .validate(schema(zodSchema))     // any Standard Schema
  .header('key', 'val')            // set a header
  .enrich(other)                   // fetch and merge
  .tap(log())                      // side effect, non-blocking
  .split()                         // fan-out per array item
  .aggregate()                     // collect back into one
  .choice(when(...), otherwise(...)?) // otherwise is optional
  .to(destination)                 // destination adapter
  .error((e, ex, fwd) => ...)      // step-scope handler
  .build()`}</CheatCode>
          </CheatSection>

          <CheatSection id="sources" eyebrow="Inputs" title="Sources">
            <CheatCode>{`// Static value or async function
.from(simple({ hello: 'world' }))
.from(simple(() => fetch('/api')))

// Emit on an interval
.from(timer({ intervalMs: 5000 }))

// Cron schedule
.from(cron('0 9 * * *'))
.from(cron('0 9 * * *',
  { timezone: 'America/New_York' }))

// In-process direct endpoint
.from(direct('my-endpoint'))

// IMAP mail (push via IDLE)
.from(mail('INBOX',
  { unseen: true, markSeen: true }))

// In-process EventEmitter
.from(event({ eventName: 'order' }))

// File and file-format sources
.from(file({ path: './data.txt' }))
.from(json({ file: './data.json' }))
.from(jsonl({ file: './events.jsonl' }))
.from(csv({ file: './rows.csv' }))
.from(html({ html: '<table>...</table>' }))`}</CheatCode>
          </CheatSection>

          <CheatSection
            id="destinations"
            eyebrow="Outputs"
            title="Destinations"
          >
            <CheatCode>{`// Log to console
.to(log())
.to(debug(ex => ex.body))

// Discard the exchange
.to(noop())

// HTTP request
.to(http({
  method: 'POST',
  url: 'https://example.com',
  body: ex => ex.body,
}))

// Dynamic URL
.to(http({ url: ex => \`/\${ex.body.id}\` }))

// In-process direct endpoint
.to(direct('my-endpoint'))

// Write file or file format
.to(file({ path: './out.txt' }))
.to(json({ file: './out.json' }))
.to(jsonl({ file: './out.jsonl' }))
.to(csv({ file: './out.csv' }))

// Send email via SMTP (payload from the exchange body)
.transform(body => ({
  to: body.email,
  subject: 'Hello',
  text: body.text,
}))
.to(mail())`}</CheatCode>
          </CheatSection>

          <CheatSection id="exchanges" eyebrow="Envelope" title="Exchanges">
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

          <CheatSection
            id="split-and-aggregate"
            eyebrow="Flow"
            title="Split &amp; aggregate"
          >
            <p>Fan out an array, process each item, collect back.</p>
            <CheatCode>{`craft()
  .from(simple([1, 2, 3]))
  .split()                  // 3 exchanges
  .transform(n => n * 2)    // each runs once
  .aggregate()              // [2, 4, 6]
  .to(log())`}</CheatCode>
          </CheatSection>

          <CheatSection
            id="choice-branching"
            eyebrow="Flow"
            title="Choice &amp; branching"
          >
            <p>
              First matching <code>when</code> wins. <code>halt()</code>{' '}
              short-circuits the branch.
            </p>
            <CheatCode>{`import { when, otherwise } from '@routecraft/routecraft'

craft()
  .from(source)
  .choice(
    when(ex => ex.body.priority === 'urgent',
      b => b.to(urgentQueue)),
    when(ex => ex.body.amount > 1000,
      b => b.to(reviewQueue)),
    otherwise(
      b => b.to(errorSink).halt()),
  )
  .to(defaultDestination)`}</CheatCode>
          </CheatSection>

          <CheatSection
            id="enrich-fetch-and-merge"
            eyebrow="Lookup"
            title="Enrich (fetch &amp; merge)"
          >
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

          <CheatSection
            id="validation-standard-schema"
            eyebrow="Safety"
            title="Validation (Standard Schema)"
          >
            <p>
              Works with Zod, Valibot, ArkType, or any Standard Schema library.
            </p>
            <CheatCode>{`import { z } from 'zod'
import { schema } from '@routecraft/routecraft'

craft()
  .from(direct('input'))
  .validate(schema(z.object({
    email: z.string().email(),
    age: z.number().min(18),
  })))
  .to(log())
// body type is inferred from the schema`}</CheatCode>
          </CheatSection>

          <CheatSection
            id="events-system"
            eyebrow="Observability"
            title="Events system"
          >
            <CheatCode>{`// Context lifecycle
ctx.on('context:started', () => {})
ctx.on('context:error', ({ details }) => {
  // { error, route?, exchange? }
})

// Route lifecycle (route id required)
ctx.on('route:my-route:started', () => {})

// Exchange tracking (use * for all routes)
ctx.on('route:*:exchange:completed',
  ({ details }) => {
    // { exchange, duration }
  })

// Step-level tracing
ctx.on('route:*:step:completed',
  ({ details }) => {
    // { operation, adapter, duration }
  })

// Wildcards
ctx.on('route:*:exchange:*', () => {})
ctx.on('plugin:*:started', () => {})`}</CheatCode>
          </CheatSection>

          <CheatSection
            id="error-handling"
            eyebrow="Recovery"
            title="Error handling"
          >
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
RC3xxx  Lifecycle
RC5xxx  Adapter (incl. auth)
RC9xxx  Testing`}</CheatCode>
          </CheatSection>

          <CheatSection
            id="context-and-plugins"
            eyebrow="Runtime"
            title="Context &amp; plugins"
          >
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

          <CheatSection id="llm" eyebrow="AI" title="LLM destination">
            <p>
              Model id is <code>provider:model</code>. Providers (Anthropic,
              OpenAI, Ollama, Gemini, OpenRouter) are registered via{' '}
              <code>llmPlugin</code>.
            </p>
            <CheatCode>{`import { llm } from '@routecraft/ai'

// Basic call (user prompt defaults to body)
craft()
  .from(direct('text-in'))
  .to(llm('anthropic:claude-sonnet-4-6', {
    system: 'Summarize concisely',
    user: ex => ex.body.text,
    temperature: 0.2,
  }))
  .to(log())

// Structured output (body.output is typed)
.to(llm('openai:gpt-4o', {
  system: 'Extract contact info',
  output: z.object({
    email: z.string().email(),
    name: z.string(),
  }),
}))`}</CheatCode>
          </CheatSection>

          <CheatSection id="agents" eyebrow="AI" title="Agents &amp; tools">
            <p>
              <code>agent()</code> runs a multi-turn tool-calling loop.{' '}
              <code>tools()</code> selects from MCP tools, registered functions,
              and direct routes.
            </p>
            <CheatCode>{`import { agent, tools } from '@routecraft/ai'

craft()
  .id('assistant')
  .from(direct('chat-in'))
  .to(agent({
    model: 'anthropic:claude-sonnet-4-6',
    system: 'You are a helpful assistant.',
    user: ex => ex.body.message,
    tools: tools([
      'CurrentTime',              // registered fn
      'Direct(greet-user)',       // direct route as tool
      'MCP(github:create_issue)', // single MCP tool
      { tagged: 'read-only' },    // by tag
    ]),
  }))
  .to(log())`}</CheatCode>
            <CheatNote>
              Register functions and direct-route tools once via{' '}
              <code>
                agentPlugin({'{'} functions: {'{'} CurrentTime: currentTime(),
                greetUser: directTool({"'"}greet-user{"'"}) {'}'} {'}'})
              </code>
              .
            </CheatNote>
          </CheatSection>

          <CheatSection
            id="mcp-integration"
            eyebrow="AI"
            title="MCP integration"
          >
            <CheatLabel>Expose a route as an MCP tool</CheatLabel>
            <CheatCode>{`import { mcp } from '@routecraft/ai'

craft()
  .id('fetch-page')
  .title('Fetch page')
  .description('Fetch webpage content')
  .tag('read-only')
  .input({ body: z.object({
    url: z.string().url(),
  }) })
  .from(mcp())
  .enrich(http({ url: ex => ex.body.url }))
  .to(log())`}</CheatCode>
            <CheatLabel>Call an MCP server</CheatLabel>
            <CheatCode>{`// As a destination (invoke a remote tool)
.to(mcp('github', 'search'))`}</CheatCode>
            <CheatLabel>Protect with auth</CheatLabel>
            <CheatCode>{`import { jwt } from '@routecraft/routecraft'

craft()
  .id('private-tool')
  .authorize({ scopes: ['tools:read'] })
  .from(mcp({
    auth: jwt({ jwksUri: '...' }),
  }))
  .to(log())
// Use WorkOS / Clerk presets via mcpPlugin`}</CheatCode>
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

          <CheatSection id="cli" eyebrow="Terminal" title="CLI &amp; TUI">
            <CheatLabel>Run routes</CheatLabel>
            <CheatCode language="bash">{`# Run a route file
craft run ./my-route.ts

# With debug logging
craft run ./my-route.ts \\
  --log-level debug \\
  --log-file ./craft.log`}</CheatCode>
            <CheatLabel>Inspect with the TUI</CheatLabel>
            <p>
              Live event and exchange inspector. Requires the telemetry plugin
              enabled on the context.
            </p>
            <CheatCode language="bash">{`# Launch the TUI (reads the telemetry DB)
craft tui

# Or point it at a specific DB
craft tui --db ./app/telemetry.db`}</CheatCode>
          </CheatSection>
        </div>
      </div>
    </main>
  )
}
