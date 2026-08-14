// Canonical site identity. One source of truth for the production origin,
// used by metadata (metadataBase + canonicals), the sitemap, robots, the RSS
// feed, and structured data. Canonicals always point at the production origin,
// never a preview basePath, so search engines consolidate on one URL.

import pkg from '../../package.json'

// Both values are read through `import.meta.env` and inlined at build time, so
// they must carry the `VITE_` prefix to be exposed to the browser bundle at
// all: the version renders in the docs header and the origin is read by client
// components. Annotated because the env record is untyped.
const docVersionEnv: string | undefined = import.meta.env.VITE_DOC_VERSION
const baseUrlEnv: string | undefined = import.meta.env.VITE_BASE_URL

// The Routecraft version the site advertises (the last released version). CI
// passes VITE_DOC_VERSION on deploy (the released tag, e.g. v0.5.0, even while
// package.json is on the next in-dev version); locally it falls back to
// package.json. The leading `v` is stripped so the value is always a bare
// semver: every surface prepends its own `v`, and the CI label and a release
// ref both arrive `v`-prefixed, which would otherwise render `vv0.5.0`. Never
// hardcoded in the components.
export const docVersion = (docVersionEnv || pkg.version).replace(/^v/, '')

/**
 * The origin every absolute URL the build emits carries: canonicals, the
 * sitemap, the feed and the social card links.
 *
 * The dev server falls back to itself rather than to production. Social cards
 * have to be absolute, so a dev build that named production advertised card
 * images that only exist in this build, and no preview resolved. A production
 * build keeps the production default, so forgetting the variable in CI can
 * never publish a localhost URL. `bun run preview` sets it for the built local
 * check, and `compose.yaml` sets it for the container.
 */
export const siteUrl = (
  baseUrlEnv ||
  (import.meta.env.DEV ? 'http://localhost:3000' : 'https://routecraft.dev')
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
 * Normalise a site-relative path to the trailing-slash form the site actually
 * serves. Canonicals, og:url, JSON-LD, and feed links must use this so they
 * agree with the sitemap and the served URL instead of pointing at a 301
 * redirect, which means the router must keep serving the trailing-slash form.
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
