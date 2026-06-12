// Pure date formatting for posts, kept free of Node built-ins (`fs`/`path`) so
// it can be imported from client components like BlogMeta without dragging the
// filesystem-backed `blog.ts` into the browser bundle.
export function formatBlogDate(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
