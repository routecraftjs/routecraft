import clsx from 'clsx'

import { Icon } from '@/components/Icon'

const styles = {
  note: {
    container:
      'border border-ink/15 border-l-4 border-l-cobalt-500 bg-paper-deep/30 dark:border-paper/15 dark:border-l-cobalt-400 dark:bg-ink-soft/30',
    label: 'text-cobalt-500',
    title: 'text-ink dark:text-paper',
    body: 'text-ink/80 prose-code:text-ink prose-a:text-cobalt-500 dark:text-paper/80 dark:prose-code:text-paper dark:prose-a:text-cobalt-300',
    icon: 'text-cobalt-500 dark:text-cobalt-300',
  },
  warning: {
    container:
      'border border-ink/15 border-l-4 border-l-amber-500 bg-paper-deep/30 dark:border-paper/15 dark:border-l-amber-400 dark:bg-ink-soft/30',
    label: 'text-amber-600 dark:text-amber-400',
    title: 'text-ink dark:text-paper',
    body: 'text-ink/80 prose-code:text-ink prose-a:text-amber-600 dark:text-paper/80 dark:prose-code:text-paper dark:prose-a:text-amber-400',
    icon: 'text-amber-500 dark:text-amber-400',
  },
}

const icons = {
  note: (props: { className?: string }) => <Icon icon="lightbulb" {...props} />,
  warning: (props: { className?: string }) => (
    <Icon icon="warning" color="amber" {...props} />
  ),
}

const labels = {
  note: 'Note',
  warning: 'Warning',
}

export function Callout({
  title,
  children,
  type = 'note',
}: {
  title: string
  children: React.ReactNode
  type?: keyof typeof styles
}) {
  const IconComponent = icons[type]
  const style = styles[type]

  return (
    <div className={clsx('my-8 flex gap-4 p-5', style.container)}>
      <div className={clsx('mt-0.5 flex-none', style.icon)}>
        <IconComponent className="h-5 w-5" />
      </div>
      <div className="flex-auto">
        <div
          className={clsx(
            'not-prose flex items-baseline gap-3 font-mono text-[0.65rem] tracking-[0.22em] uppercase',
            style.label,
          )}
        >
          <span>{labels[type]}</span>
          <span className="h-px flex-1 bg-current opacity-30" />
        </div>
        <p
          className={clsx(
            'not-prose mt-2 font-editorial text-[1.2rem] tracking-[-0.01em]',
            style.title,
          )}
        >
          {title}
        </p>
        <div className={clsx('prose mt-3', style.body)}>{children}</div>
      </div>
    </div>
  )
}
