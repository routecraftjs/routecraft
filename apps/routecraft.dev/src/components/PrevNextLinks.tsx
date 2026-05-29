'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'

import { navigation } from '@/lib/navigation'

function PageLink({
  title,
  href,
  dir = 'next',
  ...props
}: Omit<React.ComponentPropsWithoutRef<'div'>, 'dir' | 'title'> & {
  title: string
  href: string
  dir?: 'previous' | 'next'
}) {
  return (
    <div {...props}>
      <dt className="font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase">
        {dir === 'next' ? 'Next' : 'Previous'}
      </dt>
      <dd className="mt-2">
        <Link
          href={href}
          className={clsx(
            'group inline-flex items-center gap-2 font-editorial text-[1.15rem] tracking-[-0.01em] text-ink transition hover:text-cobalt-500',
            dir === 'previous' && 'flex-row-reverse',
          )}
        >
          <span>{title}</span>
          <span
            aria-hidden="true"
            className={clsx(
              'font-mono transition',
              dir === 'previous'
                ? 'group-hover:-translate-x-1'
                : 'group-hover:translate-x-1',
            )}
          >
            {dir === 'previous' ? '←' : '→'}
          </span>
        </Link>
      </dd>
    </div>
  )
}

export function PrevNextLinks() {
  const rawPathname = usePathname()
  const pathname = rawPathname === '/' ? '/' : rawPathname.replace(/\/$/, '')
  const allLinks = navigation.flatMap((section) => section.links)
  const linkIndex = allLinks.findIndex((link) => link.href === pathname)
  const previousPage = linkIndex > -1 ? allLinks[linkIndex - 1] : null
  const nextPage = linkIndex > -1 ? allLinks[linkIndex + 1] : null

  if (!nextPage && !previousPage) {
    return null
  }

  return (
    <dl className="mt-16 flex border-t border-ink/15 pt-8">
      {previousPage && <PageLink dir="previous" {...previousPage} />}
      {nextPage && <PageLink className="ml-auto text-right" {...nextPage} />}
    </dl>
  )
}
