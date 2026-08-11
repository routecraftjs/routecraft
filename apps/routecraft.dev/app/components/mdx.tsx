import { MDXProvider } from '@mdx-js/react'
import { createContext, isValidElement, useContext } from 'react'
import type { ComponentProps, ReactNode } from 'react'

import { AdapterGrid } from '@/components/AdapterGrid'
import { AppLink } from '@/components/AppLink'
import { Badge } from '@/components/Badge'
import { Callout } from '@/components/Callout'
import { CodeTab, CodeTabs } from '@/components/CodeTabs'
import { ErrorTable } from '@/components/ErrorTable'
import { EventNamespaces } from '@/components/EventNamespaces'
import { Fence } from '@/components/Fence'
import { InlineCode } from '@/components/InlineCode'
import { LightboxImage } from '@/components/Lightbox'
import { OperationsIndex } from '@/components/OperationsIndex'
import { PluginIndex } from '@/components/PluginIndex'
import { QuickLink, QuickLinks } from '@/components/QuickLinks'
import { TriggerCycler } from '@/components/TriggerCycler'
import { Diagram } from '@/components/figures/Diagram'
import {
  DOCS_ROOT,
  docsChannelHref,
  withDocsChannel,
  type DocsChannelName,
} from '@/lib/docs-channel'

const ChannelContext = createContext<DocsChannelName>('latest')

function useChannel(): DocsChannelName {
  return useContext(ChannelContext)
}

/**
 * Pulls the source text and language out of the `pre`/`code` pair MDX produces.
 *
 * `Fence` and `CodeTab` were written against Markdoc, which handed them the raw
 * code as a string. MDX hands them an element tree instead, so the string is
 * recovered here rather than by rewriting both components.
 */
function readCodeElement(children: ReactNode): {
  code: string
  language: string
} {
  // A fence arrives as the `code` element; the same fence inside a `CodeTab`
  // arrives wrapped in its `pre`. Descend until the children are the source.
  let node: ReactNode = children

  while (isValidElement(node)) {
    const props = node.props as { className?: string; children?: ReactNode }

    if (typeof props.children === 'string') {
      return {
        // MDX keeps the fence's closing newline; Markdoc did not hand one over.
        code: props.children.replace(/\n$/, ''),
        language: /language-([\w-]+)/.exec(props.className ?? '')?.[1] ?? '',
      }
    }

    node = props.children
  }

  return {
    code: typeof children === 'string' ? children : '',
    language: '',
  }
}

function MdxPre({ children }: { children?: ReactNode }) {
  const { code, language } = readCodeElement(children)
  return <Fence language={language}>{code}</Fence>
}

function MdxCode({ children }: { children?: ReactNode }) {
  if (typeof children !== 'string') return <code>{children}</code>
  return <InlineCode>{children}</InlineCode>
}

function MdxCodeTab({
  label,
  language,
  children,
}: {
  label: string
  language?: string
  children?: ReactNode
}) {
  const read = readCodeElement(children)
  return (
    <CodeTab label={label} language={language ?? read.language}>
      {read.code}
    </CodeTab>
  )
}

/**
 * Renders a link inside the channel it was authored in.
 *
 * Content authors write channel-relative `/docs/...` hrefs. On the next channel
 * those resolve to `/docs/next/...`, which the Markdoc build achieved by
 * rewriting the markdown with a regex when it copied the tree. Doing it here
 * keeps the copied tree verbatim.
 */
function MdxLink({ href = '', ...props }: ComponentProps<'a'>) {
  const channel = useChannel()
  const prefix = docsChannelHref(channel)
  const isInternal = href.startsWith('/')

  if (!isInternal) {
    return <a href={href} {...props} />
  }

  const resolved = href.startsWith(DOCS_ROOT)
    ? withDocsChannel(href, prefix)
    : href

  return <AppLink href={resolved} {...props} />
}

/**
 * Lead copy is authored as a markdown block between `<Lead>` tags, so MDX hands
 * this component paragraphs rather than phrasing content. A `<p>` wrapper would
 * nest a paragraph inside a paragraph, which the HTML parser flattens into
 * siblings while React keeps them nested, and hydration fails on every page.
 *
 * The wrapper carries the `lead` typography and the block's outer spacing; the
 * paragraphs inside it drop their own edge margins so the block still measures
 * exactly as one lead paragraph did.
 */
function Lead({ children }: { children?: ReactNode }) {
  return (
    <div className="lead [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
      {children}
    </div>
  )
}

function Figure({
  src,
  alt = '',
  caption,
}: {
  src: string
  alt?: string
  caption?: string
}) {
  return (
    <figure>
      <LightboxImage src={src} alt={alt} caption={caption} />
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  )
}

/**
 * The reference catalogues must render the channel they are read on, because
 * `/docs` is frozen to the released tag while the components build from main.
 */
function channelBound<P extends { channel?: DocsChannelName }>(
  Component: (props: P) => ReactNode,
) {
  return function ChannelBound(props: Omit<P, 'channel'>) {
    const channel = useChannel()
    return <Component {...({ ...props, channel } as P)} />
  }
}

const components = {
  a: MdxLink,
  pre: MdxPre,
  code: MdxCode,
  Lead,
  Callout,
  Badge,
  QuickLinks,
  QuickLink,
  CodeTabs,
  CodeTab: MdxCodeTab,
  Diagram,
  Figure,
  TopologyDiagram: TriggerCycler,
  AdapterGrid: channelBound(AdapterGrid),
  OperationsIndex: channelBound(OperationsIndex),
  PluginIndex: channelBound(PluginIndex),
  ErrorTable: channelBound(ErrorTable),
  EventNamespaces: channelBound(EventNamespaces),
}

export function MdxComponents({
  channel,
  children,
}: {
  channel: DocsChannelName
  children: ReactNode
}) {
  return (
    <ChannelContext.Provider value={channel}>
      <MDXProvider components={components}>{children}</MDXProvider>
    </ChannelContext.Provider>
  )
}
