import clsx from 'clsx'

import { formatBlogDate } from '@/lib/blog'

export function BlogMeta({
  date,
  readingTime,
  author,
  authorRole,
  className,
}: {
  date: string
  readingTime?: number
  author?: string
  authorRole?: string
  className?: string
}) {
  return (
    <div
      className={clsx('flex flex-wrap items-center gap-x-4 gap-y-2', className)}
    >
      {date && (
        <time
          dateTime={date}
          className="font-mono text-[0.65rem] tracking-[0.2em] text-ink/55 uppercase dark:text-paper/55"
        >
          {formatBlogDate(date)}
        </time>
      )}
      {typeof readingTime === 'number' && (
        <>
          <span aria-hidden="true" className="text-ink/25 dark:text-paper/25">
            /
          </span>
          <span className="font-mono text-[0.65rem] tracking-[0.2em] text-ink/55 uppercase dark:text-paper/55">
            {readingTime} min read
          </span>
        </>
      )}
      {author && (
        <>
          <span aria-hidden="true" className="text-ink/25 dark:text-paper/25">
            /
          </span>
          <span className="font-editorial text-[1rem] text-ink/65 italic dark:text-paper/65">
            by{' '}
            <span className="text-ink not-italic dark:text-paper">
              {author}
            </span>
            {authorRole ? (
              <span className="text-ink/55 dark:text-paper/55">
                , {authorRole}
              </span>
            ) : null}
          </span>
        </>
      )}
    </div>
  )
}
