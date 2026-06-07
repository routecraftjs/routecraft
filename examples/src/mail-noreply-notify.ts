export { craftConfig } from "./craft.config";
import { craft, mail, log } from "@routecraft/routecraft";

/**
 * Watch for unseen no-reply emails via IMAP IDLE and forward a
 * notification summary to your personal inbox when one arrives.
 *
 * Mail accounts are configured in craft.config.ts (see the `mail`
 * section). Set MAIL_USER and MAIL_APP_PASSWORD in your .env file.
 */

export default craft()
  .id("mail-noreply-notify")
  .from(
    mail("INBOX", {
      unseen: true,
      markSeen: true,
      header: { "Reply-To": ["noreply", "no-reply"] },
    }),
  )
  .tap(
    log(
      (ex) =>
        `No-reply from ${ex.headers["routecraft.mail.from"]}: ` +
        `"${ex.headers["routecraft.mail.subject"]}"`,
    ),
  )
  // The mail source puts the message payload on `body` and the envelope
  // (from, subject, date, ...) on `routecraft.mail.*` headers, so read the
  // envelope off the exchange rather than the body.
  .transform((_body, ex) => ({
    to: process.env["NOTIFY_TO"] ?? process.env["MAIL_USER"] ?? "",
    subject: "Routecraft: processed a no-reply email",
    text: [
      "Hey! Routecraft just found a no-reply email and marked it as read.",
      "",
      `From: ${ex.headers["routecraft.mail.from"]}`,
      `Subject: ${ex.headers["routecraft.mail.subject"]}`,
      `Date: ${ex.headers["routecraft.mail.date"]?.toISOString()}`,
      "",
      "This message was sent by the mail-noreply-notify example.",
    ].join("\n"),
  }))
  .to(mail());
