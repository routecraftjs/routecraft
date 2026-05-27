import clsx from 'clsx'

export function CheatSection({
  title,
  eyebrow,
  children,
  className,
  span,
  id,
}: {
  title: string
  eyebrow?: string
  children: React.ReactNode
  className?: string
  span?: 'normal' | 'wide'
  id?: string
}) {
  return (
    <section
      id={id}
      className={clsx(
        'flex scroll-mt-24 break-inside-avoid flex-col gap-3 border border-ink/15 bg-paper p-5 dark:border-paper/15 dark:bg-ink-soft/30 print:break-inside-avoid',
        span === 'wide' && 'lg:col-span-2',
        className,
      )}
    >
      {eyebrow && (
        <p className="flex items-center gap-2.5 font-mono text-[0.6rem] tracking-[0.22em] text-cobalt-500 uppercase">
          <span aria-hidden="true" className="h-1 w-1 bg-cobalt-500" />
          <span>{eyebrow}</span>
        </p>
      )}
      <h2 className="font-editorial text-[1.15rem] font-medium tracking-[-0.005em] text-ink dark:text-paper">
        {title}
      </h2>
      <div className="flex flex-col gap-2.5 text-[0.82rem] leading-[1.6] text-ink/70 dark:text-paper/70">
        {children}
      </div>
    </section>
  )
}

export function CheatNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-editorial text-[0.85rem] leading-[1.5] text-ink/55 italic dark:text-paper/55">
      {children}
    </p>
  )
}

export function CheatLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[0.65rem] tracking-[0.18em] text-ink/55 uppercase dark:text-paper/55">
      {children}
    </p>
  )
}
