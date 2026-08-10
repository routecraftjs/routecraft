---
"@routecraft/routecraft": patch
---

Raise the optional `fast-xml-parser` peer floor to `^5.10.1`, excluding the `>=5.9.3 <5.10.1` window affected by GHSA-8r6m-32jq-jx6q (repeated DOCTYPE declarations reset entity expansion limits). The `xml()` adapter ships for the first time in this release, so no existing install has a floor established by Routecraft.
