import type { Metadata } from 'next'

import { getBlogPostBySlug, lastModifiedDate } from '@/lib/blog'
import { absoluteUrl, canonicalPath, siteName, siteUrl } from '@/lib/site'
import { StructuredData } from '@/components/StructuredData'

function isoDate(date: string): string | undefined {
  if (!date) return undefined
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

// Robots directives for a post that must not be discoverable: kept out of
// search indexes, with crawlers told not to follow its links or cache it.
// Applied both to drafts and to a slug that has a route but no published post
// behind it (e.g. `published: false`), so neither is left silently indexable.
const NOINDEX_ROBOTS: Metadata['robots'] = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: { index: false, follow: false },
}

/**
 * Per-post metadata, sourced from the post's frontmatter. Markdoc `.md` pages
 * can't export metadata, so each post folder has a thin `layout.tsx` that calls
 * this. The OG image is attached automatically by the post's opengraph-image.
 */
export function blogPostMetadata(slug: string): Metadata {
  const post = getBlogPostBySlug(slug)
  // No published post behind this route (unknown slug, or `published: false`).
  // The `page.md` still builds a route, so return noindex rather than empty
  // metadata to keep an unpublished page out of search results.
  if (!post) return { robots: NOINDEX_ROBOTS }
  const url = canonicalPath(`/blog/${slug}`)
  const published = isoDate(post.date)
  const modified = isoDate(lastModifiedDate(post))

  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: url },
    // Drafts stay reachable by direct link (for preview and sharing) but must
    // not be discoverable. The sitemap, RSS feed, and blog index already omit
    // drafts; this covers the page itself.
    ...(post.draft ? { robots: NOINDEX_ROBOTS } : {}),
    authors: post.author ? [{ name: post.author }] : undefined,
    openGraph: {
      type: 'article',
      title: post.title,
      description: post.description,
      url,
      publishedTime: published,
      modifiedTime: modified,
      authors: post.author ? [post.author] : undefined,
      tags: post.tags,
    },
    twitter: {
      card: 'summary_large_image',
      title: post.title,
      description: post.description,
    },
  }
}

/** BlogPosting + BreadcrumbList JSON-LD for a post. */
export function BlogPostJsonLd({ slug }: { slug: string }) {
  const post = getBlogPostBySlug(slug)
  if (!post) return null
  // A draft is noindex, so emitting BlogPosting/BreadcrumbList structured data
  // for it would be contradictory (and could still surface the post in rich
  // results). Drafts get no JSON-LD until they are published.
  if (post.draft) return null
  const url = absoluteUrl(canonicalPath(`/blog/${slug}`))
  const published = isoDate(post.date)
  const modified = isoDate(lastModifiedDate(post))

  const blogPosting = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    url,
    mainEntityOfPage: url,
    datePublished: published,
    dateModified: modified,
    inLanguage: 'en-US',
    image: absoluteUrl(`/blog/${slug}/opengraph-image`),
    author: post.author ? { '@type': 'Person', name: post.author } : undefined,
    publisher: {
      '@type': 'Organization',
      name: siteName,
      logo: { '@type': 'ImageObject', url: `${siteUrl}/icon.svg` },
    },
    keywords: post.tags?.join(', '),
  }

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Blog',
        item: `${siteUrl}/blog/`,
      },
      { '@type': 'ListItem', position: 3, name: post.title, item: url },
    ],
  }

  return (
    <>
      <StructuredData data={blogPosting} />
      <StructuredData data={breadcrumb} />
    </>
  )
}
