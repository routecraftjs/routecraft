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
  .tap(log(({ body }) => `No-reply from ${body.from}: "${body.subject}"`))
  .transform((body) => ({
    to: process.env["NOTIFY_TO"] ?? process.env["MAIL_USER"] ?? "",
    subject: "Routecraft: processed a no-reply email",
    text: [
      "Hey! Routecraft just found a no-reply email and marked it as read.",
      "",
      `From: ${body.from}`,
      `Subject: ${body.subject}`,
      `Date: ${body.date}`,
      "",
      "This message was sent by the mail-noreply-notify example.",
    ].join("\n"),
  }))
  .to(mail());
