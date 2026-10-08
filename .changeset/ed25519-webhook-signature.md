---
"@routecraft/routecraft": minor
---

`http({ signature })` gains the `"ed25519"` scheme: a public-key signature over `<timestamp><separator><raw body>`, as Telnyx (`telnyx-signature-ed25519` over `<telnyx-timestamp>|<body>`) and Discord (`x-signature-ed25519` over `<x-signature-timestamp><body>`) sign their webhooks. It takes `publicKey` (the raw 32 bytes in base64 or hex, or an SPKI `PUBLIC KEY` PEM block) in place of `secret`, the signature `header`, the `timestampHeader`, and optionally a `separator`; a delivery outside `toleranceSec` (default 300) rejects `signature expired`. The key is parsed at the `http({...})` call site, so a wrong key, or a private key pasted where the public one belongs, is `RC5003` there rather than an endless stream of 401s. The four existing schemes are unchanged.
