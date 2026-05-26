'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

const topNavLinks: Array<{ title: string; href: string; match: RegExp }> = [
  { title: 'Docs', href: '/docs/introduction', match: /^\/docs(\/|$)/ },
  { title: 'Blog', href: '/blog', match: /^\/blog(\/|$)/ },
  { title: 'Changelog', href: '/docs/changelog', match: /^\/docs\/changelog/ },
]

export function TopNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? '/'

  return (
    <nav className={clsx('hidden items-center gap-6 lg:flex', className)}>
      {topNavLinks.map((link) => {
        const isActive = link.match.test(pathname)
        return (
          <Link
            key={link.href}
            href={link.href}
            className={clsx(
              'text-sm font-medium transition',
              isActive
                ? 'text-sky-600 dark:text-sky-400'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white',
            )}
          >
            {link.title}
          </Link>
        )
      })}
    </nav>
  )
}
