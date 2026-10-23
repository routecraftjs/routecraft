---
"@routecraft/routecraft": minor
---

A message from the mail source can be deferred: `MailMessage.flags` is `string[]` and the `routecraft.mail.flags` header is `readonly string[]`, instead of the `Set<string>` and `ReadonlySet<string>` the deferral store refused with `RC5042`. A consumer that called `.has()` on the flags calls `.includes()`.
