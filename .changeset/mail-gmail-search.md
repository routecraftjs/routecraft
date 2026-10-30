---
"@routecraft/routecraft": minor
---

`mail()` takes `gmailSearch`, a Gmail search query sent as the `X-GM-RAW` IMAP extension and ANDed with the other filters. Gmail answers it from its own index, so `mail({ folder: "[Gmail]/All Mail", unseen: false, gmailSearch: "rfc822msgid:<id>" })` finds one message at once, read or not, where a `header: { "Message-ID": id }` search scans the folder and on a large mailbox runs past any route timeout. The query searches the selected folder only, and `unseen` still applies. Gmail only: a server without `X-GM-EXT-1` fails the fetch. An empty query is refused with `RC5003`. The optional `imapflow` peer range rises to `^1.0.77`, the first release that compiles `X-GM-RAW`; an older one silently ignored the key.
