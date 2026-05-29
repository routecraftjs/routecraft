'use client'

import { usePathname } from 'next/navigation'

import { navigation } from '@/lib/navigation'
import { Badge } from '@/components/Badge'
import { CopyDocsButton } from '@/components/CopyDocsButton'

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
        <CopyDocsButton />
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
