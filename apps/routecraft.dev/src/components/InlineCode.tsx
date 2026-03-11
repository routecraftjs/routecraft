export function InlineCode({ children }: { children: string }) {
  return (
    <code className="not-prose rounded bg-gray-200/70 px-1.5 py-0.5 font-mono text-[0.85em] text-gray-700 dark:bg-gray-600/50 dark:text-gray-200">
      {children}
    </code>
  )
}
