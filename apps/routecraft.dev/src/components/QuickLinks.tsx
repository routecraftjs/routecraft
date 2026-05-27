import Link from 'next/link'

import { Icon } from '@/components/Icon'

export function QuickLinks({ children }: { children: React.ReactNode }) {
  return (
    <div className="not-prose my-12 grid grid-cols-1 gap-px border border-ink/15 bg-ink/15 sm:grid-cols-2 dark:border-paper/15 dark:bg-paper/15">
      {children}
    </div>
  )
}

export function QuickLink({
  title,
  description,
  href,
  icon,
}: {
  title: string
  description: string
  href: string
  icon: React.ComponentProps<typeof Icon>['icon']
}) {
  return (
    <div className="group relative bg-paper p-6 transition hover:bg-paper-deep/40 dark:bg-ink dark:hover:bg-ink-soft/40">
      <Icon icon={icon} className="h-7 w-7 text-ink/70 dark:text-paper/70" />
      <h2 className="mt-5 font-editorial text-[1.15rem] tracking-[-0.005em] text-ink dark:text-paper">
        <Link
          href={href}
          className="transition group-hover:text-cobalt-500 dark:group-hover:text-cobalt-300"
        >
          <span className="absolute inset-0" />
          {title}
        </Link>
      </h2>
      <p className="mt-2 text-[0.9rem] leading-[1.6] text-ink/65 dark:text-paper/65">
        {description}
      </p>
    </div>
  )
}
