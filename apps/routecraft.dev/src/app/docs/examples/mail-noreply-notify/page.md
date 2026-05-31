---
title: Mail notify
---

Watch an IMAP inbox and send a notification over SMTP. {% .lead %}

Watch for unseen no-reply emails via IMAP IDLE and forward a summary to your own inbox when
one arrives. Mail accounts are configured in `craft.config.ts`; set `MAIL_USER` and
`MAIL_APP_PASSWORD` in `.env`. Source:
[`examples/src/mail-noreply-notify.ts`](https://github.com/routecraftjs/routecraft/blob/main/examples/src/mail-noreply-notify.ts).

```ts
import { craft, mail, log } from '@routecraft/routecraft'

export default craft()
  .id('mail-noreply-notify')
  .from(
    mail('INBOX', {
      unseen: true,
      markSeen: true,
      header: { 'Reply-To': ['noreply', 'no-reply'] },
    }),
  )
  .tap(log(({ body }) => `No-reply from ${body.from}: "${body.subject}"`))
  .transform((body) => ({
    to: process.env['NOTIFY_TO'] ?? process.env['MAIL_USER'] ?? '',
    subject: 'Routecraft: processed a no-reply email',
    text: `From: ${body.from}\nSubject: ${body.subject}\nDate: ${body.date}`,
  }))
  .to(mail())
```

`mail('INBOX', { ... })` as a source streams matching messages via IMAP IDLE; `mail()` as a
destination sends over SMTP. The `header` filter matches only messages whose `Reply-To` looks
like a no-reply address.

---

## Related

{% quick-links %}

{% quick-link title="mail() adapter reference" icon="presets" href="/docs/reference/adapters/mail" description="IMAP source and SMTP destination options." /%}

{% /quick-links %}
