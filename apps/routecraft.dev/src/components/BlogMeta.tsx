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
          className="font-mono text-[0.65rem] tracking-[0.2em] text-ink/55 uppercase"
        >
          {formatBlogDate(date)}
        </time>
      )}
      {typeof readingTime === 'number' && (
        <>
          <span aria-hidden="true" className="text-ink/25">
            /
          </span>
          <span className="font-mono text-[0.65rem] tracking-[0.2em] text-ink/55 uppercase">
            {readingTime} min read
          </span>
        </>
      )}
      {author && (
        <>
          <span aria-hidden="true" className="text-ink/25">
            /
          </span>
          <span className="font-editorial text-[1rem] text-ink/65 italic">
            by <span className="text-ink not-italic">{author}</span>
            {authorRole ? (
              <span className="text-ink/55">, {authorRole}</span>
            ) : null}
          </span>
        </>
      )}
    </div>
  )
}
