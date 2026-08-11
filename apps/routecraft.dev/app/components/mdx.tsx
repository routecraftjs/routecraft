import { MDXProvider } from '@mdx-js/react'
import type { ReactNode } from 'react'

function Lead({ children }: { children?: ReactNode }) {
  return <p className="lead">{children}</p>
}

function QuickLinks({ children }: { children?: ReactNode }) {
  return (
    <div className="not-prose grid grid-cols-1 gap-6 sm:grid-cols-2">
      {children}
    </div>
  )
}

function QuickLink({
  title,
  description,
  href,
}: {
  title: string
  description?: string
  href: string
}) {
  return (
    <div className="group relative rounded-xl border">
      <a href={href}>{title}</a>
      {description ? <p>{description}</p> : null}
    </div>
  )
}

const components = { Lead, QuickLinks, QuickLink }

export function MdxComponents({ children }: { children: ReactNode }) {
  return <MDXProvider components={components}>{children}</MDXProvider>
}
