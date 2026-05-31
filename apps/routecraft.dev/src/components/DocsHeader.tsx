'use client'

import { usePathname } from 'next/navigation'

import { navigation } from '@/lib/navigation'
import { Badge } from '@/components/Badge'
import { CopyDocsButton } from '@/components/CopyDocsButton'
import { docVersion } from '@/lib/site'

type BadgeColor = React.ComponentProps<typeof Badge>['color']

export function DocsHeader({
  title,
  titleBadges,
}: {
  title?: string
  titleBadges?: Array<{ text: string; color?: BadgeColor }>
}) {
  const pathname = usePathname().replace(/\/+$/, '') || '/'
  const section = navigation.find((section) =>
    section.links.find((link) => link.href === pathname),
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
          {/* Version selector. Only the latest version is published for now, so
              the dropdown is disabled; the chevron signals it will switch. */}
          <button
            type="button"
            disabled
            title={`Documentation for Routecraft v${docVersion} (only the latest version is published)`}
            aria-label={`Documentation version v${docVersion}`}
            className="inline-flex cursor-default items-center gap-2 self-stretch border border-cobalt-500/50 px-3 py-2 font-mono text-[0.65rem] tracking-[0.22em] text-cobalt-500 uppercase"
          >
            <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />v
            {docVersion}
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
          </button>
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
