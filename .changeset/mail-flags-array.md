---
"@routecraft/routecraft": minor
---

A message from the mail source can be deferred when it carries no attachments: `MailMessage.flags` and the `routecraft.mail.flags` header are `string[]` instead of a `Set<string>`, which the deferral store refused with `RC5042`. A consumer that called `.has()` on the flags calls `.includes()`. An attachment's `content` is still a `Buffer` the store refuses, so a route that defers drops or transforms `body.attachments` first.
