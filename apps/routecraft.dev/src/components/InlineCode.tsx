export function InlineCode({ children }: { children: string }) {
  return (
    <code className="not-prose rounded bg-slate-600/60 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-200 dark:bg-slate-600/50 dark:text-slate-200">
      {children}
    </code>
  )
}
