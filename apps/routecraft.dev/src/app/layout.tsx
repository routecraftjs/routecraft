import { type Metadata } from 'next'
import { IBM_Plex_Sans, Fraunces, JetBrains_Mono } from 'next/font/google'
import clsx from 'clsx'

import { Providers } from '@/app/providers'
import { Layout } from '@/components/Layout'
import { StructuredData } from '@/components/StructuredData'
import {
  organization,
  siteDescription,
  siteName,
  siteTagline,
  siteUrl,
} from '@/lib/site'

import '@/styles/tailwind.css'

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-ibm-plex-sans',
})

const fraunces = Fraunces({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-fraunces',
  axes: ['opsz', 'SOFT'],
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
})

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    template: `%s - ${siteName}`,
    default: `${siteName} - ${siteTagline}`,
  },
  description: siteDescription,
  applicationName: siteName,
  authors: [{ name: siteName, url: organization.github }],
  creator: siteName,
  publisher: siteName,
  keywords: [
    'AI automation',
    'TypeScript automation',
    'MCP',
    'Model Context Protocol',
    'Claude Desktop',
    'Cursor AI',
    'AI tools',
    'code-first automation',
    'Make.com alternative',
    'n8n alternative',
    'openclaw alternative',
    'nanoclaw alternative',
    'zapier alternative',
    'workflow automation',
  ],
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    siteName,
    title: `${siteName} - ${siteTagline}`,
    description: siteDescription,
    url: '/',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: `${siteName} - ${siteTagline}`,
    description: siteDescription,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: {
    icon: '/icon.svg',
  },
}

// Site-level structured data: the organization behind the site and the site
// itself (the latter enables a sitelinks search box in Google).
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={clsx(
        'h-full antialiased',
        ibmPlexSans.variable,
        fraunces.variable,
        jetbrainsMono.variable,
      )}
      suppressHydrationWarning
    >
      <body className="flex min-h-full bg-paper text-ink">
        <StructuredData data={organizationJsonLd} />
        <StructuredData data={websiteJsonLd} />
        <Providers>
          <Layout>{children}</Layout>
        </Providers>
      </body>
    </html>
  )
}
