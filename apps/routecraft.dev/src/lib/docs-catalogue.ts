// The reference catalogues, per docs channel. /docs publishes the last released
// version and /docs/next publishes main, but they are one build, and the
// components that render these tables are part of the site shell, which never
// freezes. So the rows are not held in the components: they live in
// src/app/docs/_data/, inside the tree the release freeze pins to the released
// tag, and reach the components through the modules generated from there by
// scripts/generate-docs-catalogue.mjs.
//
// Reading a catalogue through here rather than importing the generated modules
// directly keeps the channel lookup (and its fallback) in one place.

import { type DocsChannelName } from '@/lib/docs-channel'
import { anchorsByChannel } from '@/lib/generated/docs-anchors'
import {
  type AdapterRow,
  adaptersByChannel,
} from '@/lib/generated/docs-adapters'
import { type ErrorRow, errorsByChannel } from '@/lib/generated/docs-errors'
import {
  type EventNamespaceRow,
  eventsByChannel,
} from '@/lib/generated/docs-events'
import {
  type OperationRow,
  operationsByChannel,
} from '@/lib/generated/docs-operations'
import { type PluginRow, pluginsByChannel } from '@/lib/generated/docs-plugins'

export type { AdapterRow, ErrorRow, EventNamespaceRow, OperationRow, PluginRow }

function rows<T>(
  byChannel: Record<string, T[]>,
  channel: DocsChannelName,
): T[] {
  return byChannel[channel] ?? []
}

/** The operations the channel documents, in the order its data declares them. */
export function operations(channel: DocsChannelName): OperationRow[] {
  return rows(operationsByChannel, channel)
}

/** The adapters the channel documents. */
export function adapters(channel: DocsChannelName): AdapterRow[] {
  return rows(adaptersByChannel, channel)
}

/** The plugins the channel documents. */
export function plugins(channel: DocsChannelName): PluginRow[] {
  return rows(pluginsByChannel, channel)
}

/** The error codes the channel documents. */
export function errors(channel: DocsChannelName): ErrorRow[] {
  return rows(errorsByChannel, channel)
}

/** The event namespaces the channel documents. */
export function eventNamespaces(channel: DocsChannelName): EventNamespaceRow[] {
  return rows(eventsByChannel, channel)
}

/** Lookup key for an anchor: comparable across `RC1001`, `rc-1001`, `RC 1001`. */
function normaliseHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The anchor id a heading renders as on a page of this channel. Resolving it
 * rather than hand-building one is what keeps `RC1001` pointing at the
 * `rc-1001` that Markdoc actually emits. The generator guarantees every row has
 * its heading, so a miss can only mean a page edited out from under a stale
 * build; such a row links to the page itself rather than a dead fragment.
 */
export function resolveAnchor(
  channel: DocsChannelName,
  route: string,
  heading: string,
): string | undefined {
  return anchorsByChannel[channel]?.[route]?.[normaliseHeading(heading)]
}
