'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

export const topNavLinks: Array<{
  title: string
  href: string
  match: RegExp
}> = [
  { title: 'Docs', href: '/docs/introduction', match: /^\/docs(\/|$)/ },
  { title: 'Blog', href: '/blog', match: /^\/blog(\/|$)/ },
  {
    title: 'Cheat sheet',
    href: '/cheat-sheet',
    match: /^\/cheat-sheet(\/|$)/,
  },
  { title: 'Changelog', href: '/docs/changelog', match: /^\/docs\/changelog/ },
]

export function TopNav({ className }: { className?: string }) {
  const pathname = usePathname() ?? '/'

  return (
    <nav className={clsx('hidden items-center gap-7 lg:flex', className)}>
      {topNavLinks.map((link) => {
        const isActive = link.match.test(pathname)
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? 'page' : undefined}
            className={clsx(
              'group relative font-mono text-[0.7rem] tracking-[0.22em] uppercase transition',
              isActive
                ? 'text-cobalt-500'
                : 'text-ink/65 hover:text-ink dark:text-paper/65 dark:hover:text-paper',
            )}
          >
            <span>{link.title}</span>
            <span
              aria-hidden="true"
              className={clsx(
                'absolute inset-x-0 -bottom-1.5 h-px origin-left transition-transform duration-300',
                isActive
                  ? 'scale-x-100 bg-cobalt-500'
                  : 'scale-x-0 bg-ink/40 group-hover:scale-x-100 dark:bg-paper/40',
              )}
            />
          </Link>
        )
      })}
    </nav>
  )
}
