import { Callout } from '@/components/Callout'
import { Badge } from '@/components/Badge'
import { QuickLink, QuickLinks } from '@/components/QuickLinks'
import { CodeTabs, CodeTab } from '@/components/CodeTabs'

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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} />
        <figcaption>{caption}</figcaption>
      </figure>
    ),
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
}

export default tags
