import { AppLink } from '@/components/AppLink'
import { useRouterState } from '@tanstack/react-router'
import clsx from 'clsx'

export const topNavLinks: Array<{
  title: string
  href: string
  match: RegExp
}> = [
  { title: 'Blog', href: '/blog', match: /^\/blog(\/|$)/ },
  {
    title: 'Docs',
    href: '/docs/introduction',
    match: /^\/docs(\/|$)/,
  },
  { title: 'Changelog', href: '/changelog', match: /^\/changelog(\/|$)/ },
  {
    title: 'Cheat sheet',
    href: '/cheat-sheet',
    match: /^\/cheat-sheet(\/|$)/,
  },
]

export function TopNav({ className }: { className?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname }) ?? '/'

  return (
    <nav className={clsx('hidden items-center gap-7 lg:flex', className)}>
      {topNavLinks.map((link) => {
        const isActive = link.match.test(pathname)
        return (
          <AppLink
            key={link.href}
            href={link.href}
            aria-current={isActive ? 'page' : undefined}
            className={clsx(
              'group relative font-mono text-[0.7rem] tracking-[0.22em] uppercase transition',
              isActive ? 'text-cobalt-500' : 'text-ink/65 hover:text-ink',
            )}
          >
            <span>{link.title}</span>
            <span
              aria-hidden="true"
              className={clsx(
                'absolute inset-x-0 -bottom-1.5 h-0.5 origin-left transition-transform duration-300',
                isActive
                  ? 'scale-x-100 bg-cobalt-500'
                  : 'scale-x-0 bg-ink/40 group-hover:scale-x-100',
              )}
            />
          </AppLink>
        )
      })}
    </nav>
  )
}
