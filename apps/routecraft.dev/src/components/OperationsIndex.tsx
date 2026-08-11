import Link from 'next/link'

import { documentsPage } from '@/lib/docs-catalogue'
import {
  type DocsChannelName,
  docsChannelHref,
  withDocsChannel,
} from '@/lib/docs-channel'
import { type Section } from '@/lib/sections'
import { slug } from '@/lib/slug'

interface Op {
  name: string
  category: string
  signature: string
  description: string
  planned?: boolean
}

const ops: Op[] = [
  // Route
  {
    name: 'id',
    category: 'Route',
    signature: '.id(name)',
    description: 'Set the unique identifier for the route.',
  },
  {
    name: 'title',
    category: 'Route',
    signature: '.title(text)',
    description: 'Display title for tooling and docs.',
  },
  {
    name: 'description',
    category: 'Route',
    signature: '.description(text)',
    description: 'Free-text description for the route.',
  },
  {
    name: 'input',
    category: 'Route',
    signature: '.input({ body, headers })',
    description: 'Validate the incoming exchange against a Standard Schema.',
  },
  {
    name: 'output',
    category: 'Route',
    signature: '.output({ body, headers })',
    description: 'Validate the outgoing exchange against a Standard Schema.',
  },
  {
    name: 'tag',
    category: 'Route',
    signature: '.tag(value)',
    description: 'Attach one or more tags for filtering and discovery.',
  },
  {
    name: 'batch',
    category: 'Route',
    signature: '.batch(options?)',
    description: 'Process exchanges in batches instead of one at a time.',
  },
  {
    name: 'error',
    category: 'Route',
    signature: '.error(handler)',
    description:
      'Catch route-scope errors before from(), or wrap the next step after from().',
  },
  {
    name: 'authorize',
    category: 'Route',
    signature: '.authorize({ roles, scopes })',
    description:
      'Require an authenticated principal with optional roles or scopes.',
  },
  {
    name: 'from',
    category: 'Route',
    signature: '.from(source)',
    description: 'Set the source that produces exchanges.',
  },

  // Wrapper
  {
    name: 'retry',
    category: 'Wrapper',
    signature: '.retry(options?)',
    description: 'Retry the next operation (or the whole pipeline) on failure.',
  },
  {
    name: 'throttle',
    category: 'Wrapper',
    signature: '.throttle({ rate, per })',
    description: 'Rate-limit the next operation (or the whole pipeline).',
  },
  {
    name: 'timeout',
    category: 'Wrapper',
    signature: '.timeout(ms)',
    description:
      'Fail the next operation (or the whole pipeline) after a deadline.',
  },
  {
    name: 'delay',
    category: 'Wrapper',
    signature: '.delay(ms)',
    description: 'Pause before the next operation.',
  },
  {
    name: 'cache',
    category: 'Wrapper',
    signature: '.cache({ key, ttl })',
    description: 'Cache and reuse the result of the next operation.',
  },
  {
    name: 'circuitBreaker',
    category: 'Wrapper',
    signature: '.circuitBreaker({ failureThreshold })',
    description:
      'Trip after repeated failures and fast-fail until the target recovers.',
  },
  {
    name: 'concurrency',
    category: 'Wrapper',
    signature: '.concurrency({ max })',
    description:
      'Bound how many exchanges run the next operation (or the whole pipeline) at once (bulkhead).',
  },

  // Transform
  {
    name: 'transform',
    category: 'Transform',
    signature: '.transform(fn)',
    description: "Replace the body with the function's return value.",
  },
  {
    name: 'header',
    category: 'Transform',
    signature: '.header(name, value)',
    description: 'Set or override an exchange header.',
  },
  {
    name: 'authenticate',
    category: 'Transform',
    signature: '.authenticate(resolver)',
    description: 'Mint a principal from claims the resolver has verified.',
  },
  {
    name: 'delegate',
    category: 'Transform',
    signature: '.delegate(resolver)',
    description:
      'Mark the principal as exercised by an actor (an agent) on the subject’s behalf.',
  },
  {
    name: 'map',
    category: 'Transform',
    signature: '.map(mapping)',
    description: 'Map fields from source to target via a declarative mapping.',
  },
  {
    name: 'process',
    category: 'Transform',
    signature: '.process(fn)',
    description: 'Transform with full read-write access to the exchange.',
  },
  {
    name: 'enrich',
    category: 'Transform',
    signature: '.enrich(enricher, aggregator?)',
    description:
      'Pull data in; the result replaces the body unless an aggregator merges it.',
  },

  // Flow Control
  {
    name: 'filter',
    category: 'Flow Control',
    signature: '.filter(predicate)',
    description: 'Drop exchanges that fail the predicate.',
  },
  {
    name: 'validate',
    category: 'Flow Control',
    signature: '.validate(validator)',
    description:
      'Check the body with a validator; the coerced result replaces it.',
  },
  {
    name: 'schema',
    category: 'Flow Control',
    signature: '.schema(schema)',
    description:
      'Strip unknown fields per a schema, fail on validation errors.',
  },
  {
    name: 'dedupe',
    category: 'Flow Control',
    signature: '.dedupe({ key })',
    description: 'Drop exchanges whose derived key has already been seen.',
  },
  {
    name: 'choice',
    category: 'Flow Control',
    signature: '.choice(when(...), otherwise(...)?)',
    description: 'Branch the pipeline by predicate.',
  },
  {
    name: 'split',
    category: 'Flow Control',
    signature: '.split(fn?)',
    description: 'Fan out one exchange into many.',
  },
  {
    name: 'aggregate',
    category: 'Flow Control',
    signature: '.aggregate(fn?)',
    description: 'Fold the children of a split back into one exchange.',
  },
  {
    name: 'multicast',
    category: 'Flow Control',
    signature: '.multicast(...paths)',
    description: 'Fan the exchange out to multiple paths in parallel.',
  },
  {
    name: 'dispatch',
    category: 'Flow Control',
    signature: '.dispatch(strategy, ...targets)',
    description: 'Run exactly one target, chosen by load-balancing strategy.',
  },
  {
    name: 'loop',
    category: 'Flow Control',
    signature: '.loop(condition)',
    description: 'Repeat a sub-pipeline while a condition holds.',
    planned: true,
  },
  {
    name: 'sample',
    category: 'Flow Control',
    signature: '.sample({ every } | { intervalMs })',
    description: 'Pass every Nth exchange, or the first per time window.',
  },
  {
    name: 'debounce',
    category: 'Flow Control',
    signature: '.debounce({ waitMs })',
    description:
      'Release only the last exchange in a burst after a quiet period.',
  },
  {
    name: 'suspend',
    category: 'Flow Control',
    signature: '.suspend({ expect, ttl? })',
    description:
      'Park the exchange durably and answer now; resume later at the next step.',
  },
  {
    name: 'resume',
    category: 'Flow Control',
    signature: '.resume(map?)',
    description:
      'Revive a parked exchange addressed by its signed resume token.',
  },

  // Side Effects
  {
    name: 'tap',
    category: 'Side Effects',
    signature: '.tap(target)',
    description:
      'Run a destination or enricher fire-and-forget; the body is unchanged.',
  },
  {
    name: 'log',
    category: 'Side Effects',
    signature: '.log(formatter?)',
    description: 'Emit a log line for the exchange.',
  },
  {
    name: 'debug',
    category: 'Side Effects',
    signature: '.debug(formatter?)',
    description: 'Emit a log line for the exchange at debug level.',
  },
  {
    name: 'to',
    category: 'Side Effects',
    signature: '.to(destination)',
    description:
      'Push out via a destination (body unchanged) or pull in via an enricher (body replaced).',
  },
]

const categories = [
  'Route',
  'Wrapper',
  'Transform',
  'Flow Control',
  'Side Effects',
] as const

/** The reference page an operation row links to, relative to the channel root. */
function opRoute(op: Op): string {
  return `reference/operations/${slug(op.name)}`
}

/**
 * The operations this channel documents. `ops` ships with the site shell, which
 * always builds from main, while /docs is frozen to the last released tag: an
 * operation that only exists on main would otherwise be listed as released and
 * link to a page the released channel does not carry.
 */
function channelOps(channel: DocsChannelName): Array<Op> {
  return ops.filter((op) => documentsPage(channel, opRoute(op)))
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
  const visible = channelOps(channel)
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

export function OperationsIndex({
  channel = 'latest',
}: {
  channel?: DocsChannelName
}) {
  const visible = channelOps(channel)
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
                  <Link
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
