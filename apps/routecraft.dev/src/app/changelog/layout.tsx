import fs from 'fs'
import path from 'path'
import type { Metadata } from 'next'

import { parseFrontmatter } from '@/lib/frontmatter'
import { canonicalPath, siteName } from '@/lib/site'

// The changelog lives outside the versioned /docs tree (it spans versions and
// ships on the main-branch cadence), so the docs route-shim generator does not
// cover it. This thin layout supplies its per-page metadata the same way a
// generated docs layout would, reading the title from the page frontmatter.
function changelogTitle(): string {
  try {
    const md = fs.readFileSync(
      path.join(process.cwd(), 'src', 'app', 'changelog', 'page.md'),
      'utf8',
    )
    const { data } = parseFrontmatter(md)
    return typeof data.title === 'string' ? data.title : 'Changelog'
  } catch {
    return 'Changelog'
  }
}

const title = `${changelogTitle()} - ${siteName}`
const url = canonicalPath('/changelog')

export const metadata: Metadata = {
  title: { absolute: title },
  description: 'All notable changes to Routecraft, across released versions.',
  alternates: { canonical: url },
  openGraph: { type: 'article', title, url },
  twitter: { card: 'summary_large_image', title },
}

export default function ChangelogLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
