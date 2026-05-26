import clsx from 'clsx'

import { formatBlogDate } from '@/lib/blog'

export function BlogMeta({
  date,
  readingTime,
  author,
  authorRole,
  className,
  divider = '•',
}: {
  date: string
  readingTime?: number
  author?: string
  authorRole?: string
  className?: string
  divider?: string
}) {
  const parts: React.ReactNode[] = []
  if (date) {
    parts.push(
      <time key="date" dateTime={date}>
        {formatBlogDate(date)}
      </time>,
    )
  }
  if (typeof readingTime === 'number') {
    parts.push(<span key="rt">{readingTime} min read</span>)
  }
  if (author) {
    parts.push(
      <span key="author">
        by{' '}
        <span className="font-medium text-gray-700 dark:text-gray-300">
          {author}
        </span>
        {authorRole ? (
          <span className="text-gray-500 dark:text-gray-500">
            , {authorRole}
          </span>
        ) : null}
      </span>,
    )
  }

  return (
    <div
      className={clsx(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500 dark:text-gray-400',
        className,
      )}
    >
      {parts.map((part, index) => (
        <span key={index} className="flex items-center gap-x-3">
          {part}
          {index < parts.length - 1 && (
            <span
              aria-hidden="true"
              className="text-gray-300 dark:text-gray-600"
            >
              {divider}
            </span>
          )}
        </span>
      ))}
    </div>
  )
}
