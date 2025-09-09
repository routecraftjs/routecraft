'use client'

import { usePathname } from 'next/navigation'

import { navigation } from '@/lib/navigation'
import { Badge } from '@/components/Badge'

export function DocsHeader({
  title,
  titleBadges,
}: {
  title?: string
  titleBadges?: Array<{ text: string; color?: string }>
}) {
  let pathname = usePathname()
  let section = navigation.find((section) =>
    section.links.find((link) => link.href === pathname),
  )

  if (!title && !section) {
    return null
  }

  return (
    <header className="mb-9 space-y-1">
      {section && (
        <p className="font-display text-sm font-medium text-sky-500">
          {section.title}
        </p>
      )}
      {title && (
        <h1 className="font-display text-3xl tracking-tight text-gray-900 dark:text-white">
          <span className="inline-flex items-center gap-2">
            <span>{title}</span>
            {titleBadges?.map((b, i) => (
              <Badge key={i} color={(b.color as any) ?? 'yellow'}>
                {b.text}
              </Badge>
            ))}
          </span>
        </h1>
      )}
    </header>
  )
}
