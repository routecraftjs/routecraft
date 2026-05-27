import clsx from 'clsx'

export function Prose<T extends React.ElementType = 'div'>({
  as,
  className,
  ...props
}: React.ComponentPropsWithoutRef<T> & {
  as?: T
}) {
  const Component = as ?? 'div'

  return (
    <Component
      className={clsx(
        className,
        'prose max-w-none text-ink prose-slate dark:text-paper dark:prose-invert',
        // strong
        'prose-strong:text-ink dark:prose-strong:text-paper',
        // headings: Fraunces with negative tracking, ink color
        'prose-headings:scroll-mt-28 prose-headings:font-editorial prose-headings:font-medium prose-headings:tracking-[-0.015em] prose-headings:text-ink lg:prose-headings:scroll-mt-34 dark:prose-headings:text-paper',
        'prose-h1:text-[clamp(2.25rem,4.5vw,3.25rem)] prose-h1:leading-[1.05]',
        'prose-h2:mt-16 prose-h2:text-[1.875rem] prose-h2:leading-[1.15]',
        'prose-h3:mt-10 prose-h3:text-[1.375rem] prose-h3:leading-[1.25]',
        // lead
        'prose-lead:text-ink/70 dark:prose-lead:text-paper/70',
        // links: cobalt with hairline underline that thickens on hover
        'prose-a:font-medium prose-a:text-cobalt-500 prose-a:no-underline dark:prose-a:text-cobalt-300',
        'prose-a:shadow-[inset_0_-1px_0_0_var(--color-cobalt-500)] prose-a:hover:shadow-[inset_0_-2px_0_0_var(--color-cobalt-500)] dark:prose-a:shadow-[inset_0_-1px_0_0_var(--color-cobalt-400)] dark:prose-a:hover:shadow-[inset_0_-2px_0_0_var(--color-cobalt-400)]',
        // code blocks (pre): hairline border, paper-deep bg
        'prose-pre:rounded-none prose-pre:border prose-pre:border-ink/15 prose-pre:bg-paper-deep/40 prose-pre:shadow-none dark:prose-pre:border-paper/15 dark:prose-pre:bg-ink-soft/40',
        // hr: hairline
        'prose-hr:border-ink/15 dark:prose-hr:border-paper/15',
        // blockquote: cobalt left bar, italic Fraunces
        'prose-blockquote:border-l-2 prose-blockquote:border-cobalt-500 prose-blockquote:font-editorial prose-blockquote:text-ink/85 prose-blockquote:not-italic dark:prose-blockquote:text-paper/85',
        // tables: hairline grid
        'prose-th:border-b prose-th:border-ink/30 prose-th:font-mono prose-th:text-[0.7rem] prose-th:tracking-[0.18em] prose-th:uppercase dark:prose-th:border-paper/30',
        'prose-td:border-b prose-td:border-ink/10 dark:prose-td:border-paper/10',
      )}
      {...props}
    />
  )
}
