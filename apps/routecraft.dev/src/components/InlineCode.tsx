export function InlineCode({ children }: { children: string }) {
  return (
    <code className="not-prose border border-ink/15 bg-paper-deep/40 px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
      {children}
    </code>
  )
}
