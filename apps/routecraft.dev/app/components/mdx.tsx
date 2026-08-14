import { MDXProvider } from '@mdx-js/react'
import { createContext, useContext } from 'react'
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
import { readCodeSource } from '@/lib/code-source'
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

function MdxPre({ children }: { children?: ReactNode }) {
  const { code, language } = readCodeSource(children)
  return <Fence language={language}>{code}</Fence>
}

function MdxCode({ children }: { children?: ReactNode }) {
  if (typeof children !== 'string') return <code>{children}</code>
  return <InlineCode>{children}</InlineCode>
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
 * Markdown images open in a lightbox so diagrams and screenshots can be
 * inspected at full resolution, which is what the Markdoc image node did.
 */
function MdxImage({ src, alt, title }: ComponentProps<'img'>) {
  if (typeof src !== 'string') return null
  return <LightboxImage src={src} alt={alt ?? ''} caption={title} />
}

/**
 * A reference table is as wide as its widest cell, and cells holding a code
 * signature cannot wrap. Left in the prose flow that width becomes the width of
 * the page, so a phone scrolls the whole document sideways. The scroll belongs
 * to the table.
 *
 * The frame carries the vertical rhythm the table would otherwise set for
 * itself (`prose` gives a table 28px, which is `my-7`), because a scroll
 * container traps its child's margins and the gap above and below every table
 * would grow by the neighbouring paragraph's margin.
 */
function MdxTable(props: ComponentProps<'table'>) {
  return (
    <div className="my-7 scrollbar-quiet overflow-x-auto [&>table]:my-0">
      <table {...props} />
    </div>
  )
}

/** Header cells carry their scope, as the Markdoc table node set. */
function MdxTableHeader(props: ComponentProps<'th'>) {
  return <th scope="col" {...props} />
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
  img: MdxImage,
  table: MdxTable,
  th: MdxTableHeader,
  Lead,
  Callout,
  Badge,
  QuickLinks,
  QuickLink,
  CodeTabs,
  CodeTab,
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
