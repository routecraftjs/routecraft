import { type BadgeColor } from '@/components/Badge'
import { DocsHeader } from '@/components/DocsHeader'
import { PrevNextLinks } from '@/components/PrevNextLinks'
import { Prose } from '@/components/Prose'
import { TableOfContents } from '@/components/TableOfContents'
import { type Section } from '@/lib/sections'

export function DocsLayout({
  children,
  frontmatter: { title, titleBadges },
  sections,
}: {
  children: React.ReactNode
  frontmatter: {
    title?: string
    titleBadges?: Array<{ text: string; color?: BadgeColor }>
  }
  sections: Array<Section>
}) {
  return (
    <>
      <div className="max-w-2xl min-w-0 flex-auto py-16 lg:max-w-none lg:pr-0 lg:pl-8 xl:pr-16 xl:pl-16">
        <article>
          <DocsHeader title={title} titleBadges={titleBadges} />
          <Prose>{children}</Prose>
        </article>
        <PrevNextLinks />
      </div>
      <TableOfContents tableOfContents={sections} />
    </>
  )
}
