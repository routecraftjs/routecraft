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
  organization,
  siteDescription,
  siteName,
  siteTagline,
  siteUrl,
} from '@/lib/site'

import appStyles from '@/styles/tailwind.css?url'

const FONT_STYLESHEET =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Fraunces:opsz,SOFT@9..144,0..100&family=JetBrains+Mono:wght@400;500&display=swap'

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

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: `${siteName} - ${siteTagline}` },
      { name: 'description', content: siteDescription },
      { name: 'application-name', content: siteName },
    ],
    links: [
      { rel: 'stylesheet', href: appStyles },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      { rel: 'stylesheet', href: FONT_STYLESHEET },
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
