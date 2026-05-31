// Canonical site identity. One source of truth for the production origin,
// used by metadata (metadataBase + canonicals), the sitemap, robots, the RSS
// feed, and structured data. Canonicals always point at the production origin,
// never a preview basePath, so search engines consolidate on one URL.

import pkg from '../../package.json'

// The Routecraft version the site advertises (the last released version). CI
// passes NEXT_PUBLIC_DOC_VERSION on deploy (the released tag, e.g. v0.5.0, even
// while package.json is on the next in-dev version); locally it falls back to
// package.json. The leading `v` is stripped so the value is always a bare
// semver: every surface prepends its own `v`, and the CI label and a release
// ref both arrive `v`-prefixed, which would otherwise render `vv0.5.0`. Never
// hardcoded in the components.
export const docVersion = (
  process.env.NEXT_PUBLIC_DOC_VERSION || pkg.version
).replace(/^v/, '')

export const siteUrl = (
  process.env.NEXT_PUBLIC_BASE_URL || 'https://routecraft.dev'
).replace(/\/+$/, '')

export const siteName = 'Routecraft'

export const siteTagline = 'AI Automation as Code'

export const siteDescription =
  'Write TypeScript capabilities that send emails, manage calendars, and automate work. Expose them to any AI agent via MCP. The code-first alternative to Make.com.'

export const organization = {
  name: siteName,
  legalName: 'Routecraft',
  github: 'https://github.com/routecraftjs/routecraft',
}

/**
 * Normalise a site-relative path to the trailing-slash form the static export
 * actually serves (next.config sets `trailingSlash: true`, folder-style export).
 * Canonicals, og:url, JSON-LD, and feed links must use this so they agree with
 * the sitemap and the served URL instead of pointing at a 301 redirect.
 */
export function canonicalPath(pathname: string): string {
  if (!pathname.startsWith('/')) pathname = `/${pathname}`
  return pathname.endsWith('/') ? pathname : `${pathname}/`
}

/** Absolute production URL for a site-relative path (leading slash required). */
export function absoluteUrl(pathname: string): string {
  if (!pathname.startsWith('/')) pathname = `/${pathname}`
  return `${siteUrl}${pathname}`
}
