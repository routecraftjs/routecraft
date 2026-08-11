import { getBlogPostBySlug, lastModifiedDate } from '@/lib/blog'
import { compactMeta, type PageHead, type PageHeadMeta } from '@/lib/page-head'
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
const NOINDEX_ROBOTS: PageHeadMeta[] = [
  { name: 'robots', content: 'noindex, nofollow, nocache' },
  { name: 'googlebot', content: 'noindex, nofollow' },
]

/**
 * Per-post head metadata, sourced from the post's frontmatter.
 *
 * The title is spelled out with the site name because a plain head has no
 * title template to inherit one from.
 */
export function blogPostMetadata(slug: string): PageHead {
  const post = getBlogPostBySlug(slug)
  // No published post behind this route (unknown slug, or `published: false`).
  // The route still exists, so return noindex rather than empty metadata to
  // keep an unpublished page out of search results.
  if (!post) return { meta: [...NOINDEX_ROBOTS], links: [] }
  const url = absoluteUrl(canonicalPath(`/blog/${slug}`))
  // A cross-posted article's canonical (and og:url) points at its original
  // publication so search engines consolidate signals there instead of
  // treating the two sites as duplicating each other.
  const canonical = post.canonical ?? url
  const published = isoDate(post.date)
  const modified = isoDate(lastModifiedDate(post))

  return {
    title: `${post.title} - ${siteName}`,
    meta: compactMeta([
      post.description
        ? { name: 'description', content: post.description }
        : null,
      post.author ? { name: 'author', content: post.author } : null,
      // Drafts stay reachable by direct link (for preview and sharing) but must
      // not be discoverable. The sitemap, RSS feed, and blog index already omit
      // drafts; this covers the page itself.
      ...(post.draft ? NOINDEX_ROBOTS : []),
      { property: 'og:title', content: post.title },
      post.description
        ? { property: 'og:description', content: post.description }
        : null,
      { property: 'og:url', content: canonical },
      { property: 'og:type', content: 'article' },
      published
        ? { property: 'article:published_time', content: published }
        : null,
      modified
        ? { property: 'article:modified_time', content: modified }
        : null,
      post.author ? { property: 'article:author', content: post.author } : null,
      ...(post.tags ?? []).map((tag) => ({
        property: 'article:tag',
        content: tag,
      })),
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: post.title },
      post.description
        ? { name: 'twitter:description', content: post.description }
        : null,
    ]),
    links: [{ rel: 'canonical', href: canonical }],
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
    // For a cross-post, the main entity is the original publication, matching
    // the canonical link tag. The `url` above stays this page's own address.
    mainEntityOfPage: post.canonical ?? url,
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
