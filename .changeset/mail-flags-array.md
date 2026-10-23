---
"@routecraft/routecraft": minor
---

A message from the mail source can be deferred: `MailMessage.flags` and the `routecraft.mail.flags` header are `string[]` instead of a `Set<string>`, which the deferral store refused with `RC5042`. A consumer that called `.has()` on the flags calls `.includes()`.
