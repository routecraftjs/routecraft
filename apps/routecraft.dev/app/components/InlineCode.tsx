/**
 * Inline code carries dotted paths and call chains that hold no break
 * opportunity, so `break-words` lets one break mid-token rather than push the
 * whole page wider than a phone. Anything short enough to fit is untouched.
 */
export function InlineCode({ children }: { children: string }) {
  return (
    <code className="not-prose border border-ink/15 bg-paper-deep/40 px-1.5 py-0.5 font-mono text-[0.85em] break-words text-ink">
      {children}
    </code>
  )
}
