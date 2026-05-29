import Link from 'next/link'

import { Logo } from '@/components/Logo'

interface FooterLink {
  title: string
  href: string
  external?: boolean
}

const productLinks: FooterLink[] = [
  { title: 'Documentation', href: '/docs/introduction' },
  { title: 'Cheat sheet', href: '/cheat-sheet' },
  { title: 'Blog', href: '/blog' },
  { title: 'Changelog', href: '/docs/changelog' },
]

const referenceLinks: FooterLink[] = [
  { title: 'Adapters', href: '/docs/reference/adapters' },
  { title: 'Operations', href: '/docs/reference/operations' },
  { title: 'Plugins', href: '/docs/reference/plugins' },
  { title: 'Events', href: '/docs/reference/events' },
  { title: 'Configuration', href: '/docs/reference/configuration' },
  { title: 'CLI', href: '/docs/reference/cli' },
  { title: 'Errors', href: '/docs/reference/errors' },
]

const communityLinks: FooterLink[] = [
  {
    title: 'GitHub',
    href: 'https://github.com/routecraftjs/routecraft',
    external: true,
  },
  {
    title: 'Issues',
    href: 'https://github.com/routecraftjs/routecraft/issues',
    external: true,
  },
  {
    title: 'Discussions',
    href: 'https://github.com/routecraftjs/routecraft/discussions',
    external: true,
  },
  { title: 'Contributing', href: '/docs/community/contribution-guide' },
  { title: 'FAQ', href: '/docs/community/faq' },
]

function FooterLinkItem({ link }: { link: FooterLink }) {
  const className =
    'group inline-flex items-center gap-1.5 font-editorial text-[1.02rem] text-ink/70 transition hover:text-cobalt-500'
  if (link.external) {
    return (
      <li>
        <a href={link.href} className={className}>
          <span>{link.title}</span>
          <span
            aria-hidden="true"
            className="text-[0.75em] text-ink/30 transition group-hover:text-cobalt-500"
          >
            ↗
          </span>
        </a>
      </li>
    )
  }
  return (
    <li>
      <Link href={link.href} className={className}>
        <span>{link.title}</span>
      </Link>
    </li>
  )
}

function FooterColumn({
  heading,
  links,
}: {
  heading: string
  links: FooterLink[]
}) {
  return (
    <div>
      <h3 className="flex items-center gap-3 border-b border-ink/15 pb-3 font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
        <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
        <span>{heading}</span>
      </h3>
      <ul role="list" className="mt-5 space-y-2.5">
        {links.map((link) => (
          <FooterLinkItem key={link.href} link={link} />
        ))}
      </ul>
    </div>
  )
}

export function Footer() {
  const year = new Date().getFullYear()
  return (
    <footer className="relative border-t border-ink/15 bg-paper-deep/50">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-x-12 gap-y-14 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
              <Logo className="h-8 w-8 shrink-0 text-ink" />
              <span
                className="font-editorial text-[1.75rem] leading-none tracking-[-0.02em] text-ink"
                style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
              >
                Routecraft
              </span>
            </div>
            <p className="max-w-xs font-editorial text-[1.05rem] leading-[1.65] text-ink/70">
              <span className="text-cobalt-500 italic">
                AI automation as code.
              </span>{' '}
              A type-safe framework for connecting AI agents to your real
              systems.
            </p>
          </div>
          <FooterColumn heading="Product" links={productLinks} />
          <FooterColumn heading="Reference" links={referenceLinks} />
          <FooterColumn heading="Community" links={communityLinks} />
        </div>

        <div className="mt-16 flex flex-col gap-4 border-t border-ink/15 pt-6 sm:flex-row sm:items-end sm:justify-between">
          <p className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
            © {year} Routecraft · Apache 2.0
          </p>
          <p className="font-editorial text-[1rem] text-ink/65 italic">
            Built by{' '}
            <a
              href="https://devoptix.nl"
              className="text-cobalt-500 not-italic transition hover:text-cobalt-600"
            >
              DevOptix
            </a>
            .
          </p>
        </div>
      </div>
    </footer>
  )
}
