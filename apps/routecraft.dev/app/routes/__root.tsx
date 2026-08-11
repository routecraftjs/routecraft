import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'

import { Layout } from '@/components/Layout'
import { Providers } from '@/components/Providers'
import { StructuredData } from '@/components/StructuredData'
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_TYPE,
  OG_IMAGE_WIDTH,
  rootOgImage,
} from '@/lib/generated/og-images'
import {
  organization,
  siteDescription,
  siteName,
  siteTagline,
  siteUrl,
} from '@/lib/site'

import appStyles from '@/styles/tailwind.css?url'

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: organization.name,
  legalName: organization.legalName,
  url: siteUrl,
  logo: `${siteUrl}/icon.svg`,
  sameAs: [organization.github],
}

const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: siteName,
  url: siteUrl,
  description: siteDescription,
}

// The site's social card, inherited by every route that does not set its own.
// Blog posts override the whole group in `blogPostMetadata`.
const socialImage = `${siteUrl}${rootOgImage}`
const socialImageAlt = `${siteName} - ${siteTagline}`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: `${siteName} - ${siteTagline}` },
      { name: 'description', content: siteDescription },
      { name: 'application-name', content: siteName },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: siteName },
      { property: 'og:locale', content: 'en_US' },
      { property: 'og:title', content: `${siteName} - ${siteTagline}` },
      { property: 'og:description', content: siteDescription },
      { property: 'og:url', content: `${siteUrl}/` },
      { name: 'twitter:title', content: `${siteName} - ${siteTagline}` },
      { name: 'twitter:description', content: siteDescription },
      { property: 'og:image', content: socialImage },
      { property: 'og:image:type', content: OG_IMAGE_TYPE },
      { property: 'og:image:width', content: String(OG_IMAGE_WIDTH) },
      { property: 'og:image:height', content: String(OG_IMAGE_HEIGHT) },
      { property: 'og:image:alt', content: socialImageAlt },
      // Without a card type X renders no image at all, so it travels with the
      // image rather than with the rest of the Twitter metadata.
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:image', content: socialImage },
      { name: 'twitter:image:alt', content: socialImageAlt },
      { name: 'twitter:image:type', content: OG_IMAGE_TYPE },
      { name: 'twitter:image:width', content: String(OG_IMAGE_WIDTH) },
      { name: 'twitter:image:height', content: String(OG_IMAGE_HEIGHT) },
    ],
    links: [
      { rel: 'stylesheet', href: appStyles },
      { rel: 'icon', href: '/icon.svg' },
      {
        rel: 'alternate',
        type: 'application/rss+xml',
        title: `${siteName} Blog`,
        href: '/feed.xml',
      },
    ],
  }),
  component: RootDocument,
})

function RootDocument() {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-full bg-paper text-ink">
        <StructuredData data={organizationJsonLd} />
        <StructuredData data={websiteJsonLd} />
        <Providers>
          <Layout>
            <Outlet />
          </Layout>
        </Providers>
        <Scripts />
      </body>
    </html>
  )
}
