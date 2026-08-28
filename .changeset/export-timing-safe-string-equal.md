---
"@routecraft/routecraft": minor
---

`timingSafeStringEqual` is now exported from the package root.

A custom `validator` is the supported way to admit a request on a shared secret, and it works on every surface that takes one, the MCP server included. Until now nobody outside the package could write that comparison safely: `===` on a secret returns as soon as two bytes differ, and the time it took is a measurement an attacker can repeat to recover the secret a byte at a time. The framework had the constant-time comparison already and kept it to itself.

The documented custom-validator example on `ValidatorAuthOptions` now uses it, so the pattern a reader copies is the safe one.
