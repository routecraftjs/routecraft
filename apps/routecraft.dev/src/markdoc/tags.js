import { Callout } from '@/components/Callout'
import { Diagram } from '@/components/figures/Diagram'
import { LightboxImage } from '@/components/Lightbox'
import { Badge } from '@/components/Badge'
import { QuickLink, QuickLinks } from '@/components/QuickLinks'
import { CodeTabs, CodeTab } from '@/components/CodeTabs'
import { TriggerCycler } from '@/components/TriggerCycler'
import { AdapterGrid } from '@/components/AdapterGrid'
import { OperationsIndex } from '@/components/OperationsIndex'
import { PluginIndex } from '@/components/PluginIndex'
import { ErrorTable } from '@/components/ErrorTable'
import { EventNamespaces } from '@/components/EventNamespaces'

// The reference index tags render catalogues that must match the docs channel
// they are read on: /docs is frozen to the released tag while these components
// build from main. `channel` is absent on the released channel (hence the
// default) and injected as `channel="next"` by scripts/generate-docs-next.mjs
// when it copies a page into /docs/next. See src/lib/docs-catalogue.ts.
const channelAttribute = {
  channel: { type: String, default: 'latest', matches: ['latest', 'next'] },
}

const tags = {
  callout: {
    attributes: {
      title: { type: String },
      type: {
        type: String,
        default: 'note',
        matches: ['note', 'warning'],
        errorLevel: 'critical',
      },
    },
    render: Callout,
  },
  figure: {
    selfClosing: true,
    attributes: {
      src: { type: String },
      alt: { type: String },
      caption: { type: String },
    },
    render: ({ src, alt = '', caption }) => (
      <figure>
        <LightboxImage src={src} alt={alt} caption={caption} />
        {caption ? <figcaption>{caption}</figcaption> : null}
      </figure>
    ),
  },
  // A brand figure drawn in the DOM rather than shipped as an image, so it
  // re-tones with the theme and stays crisp at any width. `id` is a key in
  // @/components/figures; `caption` overrides the figure's own.
  diagram: {
    selfClosing: true,
    attributes: {
      id: { type: String, required: true },
      caption: { type: String },
    },
    render: Diagram,
  },
  'quick-links': {
    render: QuickLinks,
  },
  'quick-link': {
    selfClosing: true,
    render: QuickLink,
    attributes: {
      title: { type: String },
      description: { type: String },
      icon: { type: String },
      href: { type: String },
    },
  },
  'code-tabs': {
    render: CodeTabs,
  },
  'code-tab': {
    // Flatten inner Fence into plain props so CodeTabs can read strings
    render: ({ label, language, children }) => {
      function extractCode(input) {
        if (typeof input === 'string') return input
        if (Array.isArray(input)) {
          for (let item of input) {
            if (typeof item === 'string') return item
            if (
              item?.props?.children &&
              typeof item.props.children === 'string'
            ) {
              return item.props.children
            }
          }
        }
        if (
          children?.props?.children &&
          typeof children.props.children === 'string'
        ) {
          return children.props.children
        }
        return ''
      }

      function extractLanguage(input, fallback) {
        if (Array.isArray(input)) {
          for (let item of input) {
            if (item?.props?.language) return item.props.language
          }
        }
        if (input?.props?.language) return input.props.language
        return fallback
      }

      const code = extractCode(children)
      const lang = extractLanguage(children, language)

      return (
        <CodeTab label={label} language={lang}>
          {code}
        </CodeTab>
      )
    },
    attributes: {
      label: { type: String },
      language: { type: String },
    },
  },
  badge: {
    attributes: {
      color: { type: String, default: 'yellow' },
    },
    render: Badge,
  },
  'topology-diagram': {
    selfClosing: true,
    render: TriggerCycler,
  },
  'adapter-grid': {
    selfClosing: true,
    attributes: channelAttribute,
    render: AdapterGrid,
  },
  'operations-index': {
    selfClosing: true,
    attributes: channelAttribute,
    render: OperationsIndex,
  },
  'plugin-index': {
    selfClosing: true,
    attributes: channelAttribute,
    render: PluginIndex,
  },
  'error-table': {
    selfClosing: true,
    attributes: channelAttribute,
    render: ErrorTable,
  },
  'event-namespaces': {
    selfClosing: true,
    attributes: channelAttribute,
    render: EventNamespaces,
  },
}

export default tags
