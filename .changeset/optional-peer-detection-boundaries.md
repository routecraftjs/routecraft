---
"@routecraft/routecraft": patch
---

`loadOptionalPeer` recognises more of the phrasings a runtime uses for a missing optional peer, so `RC5017` and its install hint fire where a raw `ERR_MODULE_NOT_FOUND` used to escape.

Node names the package even when the import used a subpath, but Bun quotes the full specifier, so loading `pkg/subpath` reported a bare module-not-found on the runtime the CLI actually requires. The quoted name is now accepted with an optional subpath suffix.

Detection also scans every quoted occurrence in the message rather than the first. A message that names a longer package sharing the requested one's prefix before naming the requested one (`'@modelcontextprotocol/server-legacy'` ahead of `'@modelcontextprotocol/server'`) failed the boundary check against the wrong occurrence and never examined the right one. The boundary itself is unchanged: a package whose name merely starts with the requested one is still not a match, and the resolved-path phrasing still means a broken install rather than an absent peer.
