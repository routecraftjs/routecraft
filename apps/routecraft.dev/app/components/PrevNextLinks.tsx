import { AppLink } from '@/components/AppLink'
import { useRouterState } from '@tanstack/react-router'
import clsx from 'clsx'

import { navigation } from '@/lib/navigation'
import {
  docsChannelPrefix,
  stripDocsChannel,
  withDocsChannel,
} from '@/lib/docs-channel'

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
        <AppLink
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
        </AppLink>
      </dd>
    </div>
  )
}

export function PrevNextLinks() {
  const rawPathname = useRouterState({ select: (s) => s.location.pathname })
  const trimmed = rawPathname === '/' ? '/' : rawPathname.replace(/\/$/, '')
  // Match against the channel-stripped path, then render prev/next within the
  // active channel so /docs/next pages link to other /docs/next pages.
  const channelPrefix = docsChannelPrefix(trimmed)
  const pathname = stripDocsChannel(trimmed)
  const allLinks = navigation.flatMap((section) => section.links)
  const linkIndex = allLinks.findIndex((link) => link.href === pathname)
  const previousPage = linkIndex > -1 ? allLinks[linkIndex - 1] : null
  const nextPage = linkIndex > -1 ? allLinks[linkIndex + 1] : null

  if (!nextPage && !previousPage) {
    return null
  }

  return (
    <dl className="mt-16 flex border-t border-ink/15 pt-8">
      {previousPage && (
        <PageLink
          dir="previous"
          title={previousPage.title}
          href={withDocsChannel(previousPage.href, channelPrefix)}
        />
      )}
      {nextPage && (
        <PageLink
          className="ml-auto text-right"
          title={nextPage.title}
          href={withDocsChannel(nextPage.href, channelPrefix)}
        />
      )}
    </dl>
  )
}
