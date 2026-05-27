import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

import { navigation } from '@/lib/navigation'

export function Navigation({
  className,
  onLinkClick,
}: {
  className?: string
  onLinkClick?: React.MouseEventHandler<HTMLAnchorElement>
}) {
  const rawPathname = usePathname()
  const pathname =
    rawPathname !== '/' && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname

  return (
    <nav className={clsx('text-sm', className)}>
      <ul role="list" className="space-y-10">
        {navigation.map((section) => (
          <li key={section.title}>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="h-1 w-1 shrink-0 bg-cobalt-500"
              />
              {section.href ? (
                <Link
                  href={section.href}
                  onClick={onLinkClick}
                  className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/70 uppercase transition hover:text-ink dark:text-paper/70 dark:hover:text-paper"
                >
                  {section.title}
                </Link>
              ) : (
                <h2 className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/70 uppercase dark:text-paper/70">
                  {section.title}
                </h2>
              )}
            </div>
            <ul
              role="list"
              className="mt-4 space-y-2 border-l border-ink/15 dark:border-paper/15"
            >
              {section.links.map((link) => {
                const isActive = link.href === pathname
                return (
                  <li key={link.href} className="relative">
                    <Link
                      href={link.href}
                      onClick={onLinkClick}
                      aria-current={isActive ? 'page' : undefined}
                      className={clsx(
                        'block w-full pl-4 transition',
                        isActive
                          ? 'font-medium text-cobalt-500'
                          : 'text-ink/65 hover:text-ink dark:text-paper/65 dark:hover:text-paper',
                      )}
                    >
                      {link.title}
                    </Link>
                    {isActive && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-0 -left-0.5 h-full w-0.5 bg-cobalt-500"
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  )
}
