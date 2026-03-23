import { craft, mail, log, simple } from "@routecraft/routecraft";
import type { MailMessage, MailFetchResult } from "@routecraft/routecraft";

/**
 * Silly example: find the first no-reply email in your inbox,
 * mark it as seen, and send yourself a notification that it was processed.
 *
 * Configure ADAPTER_MAIL_OPTIONS on the context or set env vars:
 *   MAIL_USER, MAIL_APP_PASSWORD
 */

export default craft()
  .id("mail-noreply-notify")
  .from(simple<Record<string, never>>({}))
  .enrich(mail({ folder: "INBOX", unseen: true, limit: 20, markSeen: true }))
  .transform((body) => {
    const messages = body as unknown as MailFetchResult;
    const hit = messages.find(
      (m: MailMessage) =>
        m.from.toLowerCase().includes("noreply") ||
        m.from.toLowerCase().includes("no-reply"),
    );
    if (!hit) throw new Error("No no-reply emails found in inbox");
    return hit;
  })
  .tap(
    log((body) => {
      const msg = body as unknown as MailMessage;
      return `Found no-reply from ${msg.from}: "${msg.subject}"`;
    }),
  )
  .transform((body) => {
    const msg = body as unknown as MailMessage;
    return {
      to: "email.jaco@icloud.com",
      subject: "Routecraft: processed a no-reply email",
      text: [
        "Hey! Routecraft just found and marked a no-reply email as read.",
        "",
        `From: ${msg.from}`,
        `Subject: ${msg.subject}`,
        `Date: ${msg.date}`,
        "",
        "This message was sent by the mail-noreply-notify example.",
      ].join("\n"),
    };
  })
  .to(mail())
  .tap(log(() => "Notification sent to email.jaco@icloud.com"));
