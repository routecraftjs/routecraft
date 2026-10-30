---
"@routecraft/routecraft": minor
---

`mail()` takes `gmailSearch`, a Gmail search query sent as the `X-GM-RAW` IMAP extension and ANDed with the other filters. Gmail answers it from its own index, so `gmailSearch: "rfc822msgid:<id>"` finds one message in `[Gmail]/All Mail` at once, where a `header: { "Message-ID": id }` search scans the folder and on a large mailbox runs past any route timeout. Gmail only: a server without `X-GM-EXT-1` fails the fetch.
