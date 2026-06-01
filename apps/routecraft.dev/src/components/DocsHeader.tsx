'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react'
import clsx from 'clsx'

import { navigation } from '@/lib/navigation'
import { Badge } from '@/components/Badge'
import { CopyDocsButton } from '@/components/CopyDocsButton'
import { docVersion } from '@/lib/site'
import {
  docsChannelPrefix,
  docsChannels,
  stripDocsChannel,
  withDocsChannel,
} from '@/lib/docs-channel'

type BadgeColor = React.ComponentProps<typeof Badge>['color']

export function DocsHeader({
  title,
  titleBadges,
}: {
  title?: string
  titleBadges?: Array<{ text: string; color?: BadgeColor }>
}) {
  const rawPathname = usePathname().replace(/\/+$/, '') || '/'
  // The version switcher and the section eyebrow work off the bare (channel
  // stripped) path; links to other channels keep the reader on the same page.
  const channelPrefix = docsChannelPrefix(rawPathname)
  const barePathname = stripDocsChannel(rawPathname)
  const channels = docsChannels(docVersion)
  const activeChannel =
    channels.find((channel) => channel.prefix === channelPrefix) ?? channels[0]
  const section = navigation.find((section) =>
    section.links.find((link) => link.href === barePathname),
  )

  if (!title && !section) {
    return null
  }

  return (
    <header className="mb-12 space-y-4">
      <div className="flex items-start justify-between gap-4">
        {section ? (
          <p className="flex items-center gap-3 font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase">
            <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
            <span>{section.title}</span>
          </p>
        ) : (
          <span />
        )}
        <div className="flex shrink-0 items-center gap-3">
          {/* Version selector. Switches between the released docs and the
              in-development /docs/next channel, keeping the reader on the same
              page where it exists in the target channel. */}
          <Menu as="div" className="relative inline-flex">
            <MenuButton
              title={`Documentation version ${activeChannel.label}`}
              aria-label={`Documentation version ${activeChannel.label}`}
              className="inline-flex items-center gap-2 self-stretch border border-cobalt-500/50 px-3 py-2 font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase transition hover:bg-cobalt-500/10"
            >
              <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
              {activeChannel.label}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="h-3 w-3 text-cobalt-500/60"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </MenuButton>
            <MenuItems className="absolute top-[calc(100%+0.5rem)] right-0 z-50 w-44 border border-ink/15 bg-paper p-1 shadow-[0_20px_60px_-30px_rgba(12,12,16,0.4)]">
              {channels.map((channel) => (
                <MenuItem key={channel.prefix}>
                  {({ focus }) => (
                    <Link
                      href={withDocsChannel(barePathname, channel.prefix)}
                      className={clsx(
                        'flex w-full items-center gap-3 px-3 py-2 font-mono text-[0.7rem] tracking-[0.18em] uppercase transition',
                        focus ? 'bg-paper-deep text-ink' : 'text-ink/70',
                        channel.prefix === activeChannel.prefix &&
                          'text-cobalt-500',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="h-1 w-1 shrink-0 bg-cobalt-500"
                      />
                      {channel.label}
                    </Link>
                  )}
                </MenuItem>
              ))}
            </MenuItems>
          </Menu>
          <CopyDocsButton />
        </div>
      </div>
      {title && (
        <h1 className="font-editorial text-[clamp(2rem,4vw,3rem)] leading-[1.05] font-medium tracking-[-0.02em] text-ink">
          <span className="inline-flex items-baseline gap-3">
            <span>{title}</span>
            {titleBadges?.map((b, i) => (
              <Badge key={i} color={b.color ?? 'yellow'}>
                {b.text}
              </Badge>
            ))}
          </span>
        </h1>
      )}
    </header>
  )
}
