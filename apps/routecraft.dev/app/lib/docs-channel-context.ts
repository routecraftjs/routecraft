import { createContext, useContext } from 'react'

import {
  DOCS_ROOT,
  docsChannelHref,
  withDocsChannel,
  type DocsChannelName,
} from '@/lib/docs-channel'

/**
 * The docs channel the surrounding page is being read on.
 *
 * Lives apart from the MDX provider so any component rendered inside docs
 * content can resolve a channel-relative href, not only the ones the provider
 * maps. A component that links to `/docs/...` without going through this
 * silently drops a reader from `/docs/next` back onto the released channel.
 */
export const DocsChannelContext = createContext<DocsChannelName>('latest')

export function useDocsChannel(): DocsChannelName {
  return useContext(DocsChannelContext)
}

/**
 * Resolves a content-authored href into the channel it is being read on.
 * Anything outside the docs tree is returned untouched.
 */
export function useChannelHref(href: string): string {
  const channel = useDocsChannel()
  return href.startsWith(DOCS_ROOT)
    ? withDocsChannel(href, docsChannelHref(channel))
    : href
}
