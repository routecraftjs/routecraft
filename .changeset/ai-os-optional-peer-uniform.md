---
"@routecraft/ai": patch
"@routecraft/os": patch
---

Complete the `loadOptionalPeer` migration for the remaining bespoke sites: the mcp server's `express` load and the `agentBrowser()` `agent-browser` load now surface a missing optional peer as `RC5017` with an install hint instead of a hand-rolled error, and no longer mislabel an installed-but-broken package as missing. The optional-peer contract test now scans all four code packages, exempting regular dependencies and required peers, with the mcp `streamableHttp` sub-export probe registered as the one sanctioned bespoke exception.
