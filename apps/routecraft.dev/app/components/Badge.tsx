import clsx from 'clsx'

export type BadgeColor =
  | 'yellow'
  | 'red'
  | 'green'
  | 'gray'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  // Back-compat aliases
  | 'amber'
  | 'sky'
  | 'slate'
  | 'rose'

export function Badge({
  color = 'yellow',
  className,
  children,
}: {
  color?: BadgeColor
  className?: string
  children: React.ReactNode
}) {
  // Hairline + faint tint chips. Borders use the semantic color at low
  // alpha; text uses the same color at higher contrast.
  const colorMap: Record<string, string> = {
    gray: 'border-ink/30 text-ink/70',
    red: 'border-red-500/40 text-red-700 dark:border-red-400/40 dark:text-red-400',
    yellow:
      'border-yellow-600/40 text-yellow-800 dark:border-yellow-400/40 dark:text-yellow-400',
    green:
      'border-green-600/40 text-green-700 dark:border-green-400/40 dark:text-green-400',
    blue: 'border-cobalt-500/50 text-cobalt-600',
    indigo:
      'border-indigo-500/40 text-indigo-700 dark:border-indigo-400/40 dark:text-indigo-400',
    purple:
      'border-purple-500/40 text-purple-700 dark:border-purple-400/40 dark:text-purple-400',
    pink: 'border-pink-500/40 text-pink-700 dark:border-pink-400/40 dark:text-pink-400',
    // Back-compat aliases
    amber:
      'border-amber-500/40 text-amber-700 dark:border-amber-400/40 dark:text-amber-400',
    sky: 'border-cobalt-500/50 text-cobalt-600',
    slate: 'border-ink/30 text-ink/70',
    rose: 'border-rose-500/40 text-rose-700 dark:border-rose-400/40 dark:text-rose-400',
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center border px-1.5 py-[1px] font-mono text-[0.58rem] leading-[1.4] tracking-[0.14em] uppercase',
        colorMap[color] ?? colorMap['yellow'],
        className,
      )}
    >
      {children}
    </span>
  )
}
