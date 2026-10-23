---
"@routecraft/routecraft": minor
---

A message from the mail source can be deferred when it carries no attachments: `MailMessage.flags` is `string[]` and the `routecraft.mail.flags` header is `readonly string[]`, instead of the `Set<string>` and `ReadonlySet<string>` the deferral store refused with `RC5042`. A consumer that called `.has()` on the flags calls `.includes()`. An attachment's `content` is still a `Buffer` the store refuses, so a route that defers drops or transforms `body.attachments` first.
