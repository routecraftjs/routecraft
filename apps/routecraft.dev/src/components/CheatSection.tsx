import clsx from 'clsx'

export function CheatSection({
  title,
  eyebrow,
  children,
  className,
  span,
}: {
  title: string
  eyebrow?: string
  children: React.ReactNode
  className?: string
  span?: 'normal' | 'wide'
}) {
  return (
    <section
      className={clsx(
        'flex break-inside-avoid flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm print:break-inside-avoid print:rounded-md print:border-gray-300 print:shadow-none dark:border-gray-800 dark:bg-gray-900/40',
        span === 'wide' && 'lg:col-span-2',
        className,
      )}
    >
      {eyebrow && (
        <p className="font-display text-[0.65rem] font-semibold tracking-wider text-sky-500 uppercase">
          {eyebrow}
        </p>
      )}
      <h2 className="font-display text-base font-medium text-gray-900 dark:text-white">
        {title}
      </h2>
      <div className="flex flex-col gap-2.5 text-[0.82rem] text-gray-600 dark:text-gray-400">
        {children}
      </div>
    </section>
  )
}

export function CheatNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-gray-500 italic dark:text-gray-500">{children}</p>
  )
}

export function CheatLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-display text-[0.65rem] font-semibold tracking-wider text-gray-500 uppercase dark:text-gray-400">
      {children}
    </p>
  )
}
