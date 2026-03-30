import { type Metadata } from 'next'
import { Inter } from 'next/font/google'
import localFont from 'next/font/local'
import clsx from 'clsx'

import { Providers } from '@/app/providers'
import { Layout } from '@/components/Layout'

import '@/styles/tailwind.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

// Use local version of Lexend so that we can use OpenType features
const lexend = localFont({
  src: '../fonts/lexend.woff2',
  display: 'swap',
  variable: '--font-lexend',
})

export const metadata: Metadata = {
  title: {
    template: '%s - Routecraft',
    default: 'Routecraft - AI Automation as Code',
  },
  description:
    'Write TypeScript capabilities that send emails, manage calendars, and automate work. Expose them to any AI agent via MCP. The code-first alternative to Make.com.',
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
  openGraph: {
    title: 'Routecraft - AI Automation as Code',
    description:
      'Write TypeScript capabilities that send emails, manage calendars, and automate work. Expose them to any AI agent via MCP.',
    type: 'website',
  },
  icons: {
    icon: '/icon.svg',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={clsx('h-full antialiased', inter.variable, lexend.variable)}
      suppressHydrationWarning
    >
      <body className="flex min-h-full bg-gray-50 dark:bg-gray-950">
        <Providers>
          <Layout>{children}</Layout>
        </Providers>
      </body>
    </html>
  )
}
