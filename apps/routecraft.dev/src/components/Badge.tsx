import clsx from 'clsx'

export function Badge({
  color = 'yellow',
  className,
  children,
}: {
  color?:
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
  className?: string
  children: React.ReactNode
}) {
  const colorMap: Record<string, string> = {
    // New palette (light + dark)
    gray: 'bg-gray-100 text-gray-600 dark:bg-gray-400/10 dark:text-gray-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-400/10 dark:text-red-400',
    yellow:
      'bg-yellow-100 text-yellow-800 dark:bg-yellow-400/10 dark:text-yellow-500',
    green:
      'bg-green-100 text-green-700 dark:bg-green-400/10 dark:text-green-400',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-400/10 dark:text-blue-400',
    indigo:
      'bg-indigo-100 text-indigo-700 dark:bg-indigo-400/10 dark:text-indigo-400',
    purple:
      'bg-purple-100 text-purple-700 dark:bg-purple-400/10 dark:text-purple-400',
    pink: 'bg-pink-100 text-pink-700 dark:bg-pink-400/10 dark:text-pink-400',
    // Back-compat aliases → map to closest new palette
    amber:
      'bg-yellow-100 text-yellow-800 dark:bg-yellow-400/10 dark:text-yellow-500',
    sky: 'bg-sky-100 text-sky-700 dark:bg-sky-400/10 dark:text-sky-400',
    slate:
      'bg-slate-100 text-slate-700 dark:bg-slate-400/10 dark:text-slate-400',
    rose: 'bg-rose-100 text-rose-700 dark:bg-rose-400/10 dark:text-rose-400',
  }

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        colorMap[color] ?? colorMap['yellow'],
        className,
      )}
    >
      {children}
    </span>
  )
}
