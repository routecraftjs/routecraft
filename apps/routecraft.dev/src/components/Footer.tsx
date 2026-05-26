import Link from 'next/link'

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
  if (link.external) {
    return (
      <li>
        <a
          href={link.href}
          className="text-sm text-gray-600 transition hover:text-sky-600 dark:text-gray-400 dark:hover:text-sky-400"
        >
          {link.title}
        </a>
      </li>
    )
  }
  return (
    <li>
      <Link
        href={link.href}
        className="text-sm text-gray-600 transition hover:text-sky-600 dark:text-gray-400 dark:hover:text-sky-400"
      >
        {link.title}
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
      <h3 className="font-display text-sm font-medium text-gray-900 dark:text-white">
        {heading}
      </h3>
      <ul role="list" className="mt-4 space-y-3">
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
    <footer className="border-t border-gray-200 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-950">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/routecraft-sticker.svg"
              alt="Routecraft"
              className="h-32 w-auto select-none"
              draggable={false}
            />
            <p className="max-w-xs text-sm text-gray-600 dark:text-gray-400">
              AI automation as code. Type-safe TypeScript framework for
              connecting AI agents to your real systems.
            </p>
            <div className="flex items-center gap-3">
              <a
                href="https://github.com/routecraftjs/routecraft"
                className="text-gray-500 transition hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                aria-label="GitHub"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z" />
                </svg>
              </a>
            </div>
          </div>
          <FooterColumn heading="Product" links={productLinks} />
          <FooterColumn heading="Reference" links={referenceLinks} />
          <FooterColumn heading="Community" links={communityLinks} />
        </div>
        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-gray-200 pt-6 text-xs text-gray-500 sm:flex-row sm:items-center dark:border-gray-800 dark:text-gray-400">
          <p>
            &copy; {year} Routecraft. Released under the Apache 2.0 License.
          </p>
          <p>
            Built by{' '}
            <a
              href="https://devoptix.nl"
              className="text-gray-600 hover:text-sky-600 dark:text-gray-300 dark:hover:text-sky-400"
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
