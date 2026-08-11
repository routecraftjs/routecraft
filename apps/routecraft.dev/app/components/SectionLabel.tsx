// The hairline-rule section heading used across the blog: a cobalt tick, a mono
// uppercase label, and a rule that fills the remaining width.
export function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4">
      <span aria-hidden="true" className="h-1.5 w-1.5 bg-cobalt-500" />
      <span className="font-mono text-[0.65rem] tracking-[0.22em] text-ink/55 uppercase">
        {label}
      </span>
      <span className="h-px flex-1 bg-ink/15" />
    </div>
  )
}
