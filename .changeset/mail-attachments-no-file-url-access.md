---
"@routecraft/routecraft": patch
---

`mail()` no longer lets a message read local files or fetch URLs. Attachments were handed to nodemailer as they arrived, so an attachment in an untrusted body (an HTTP request, an MCP tool call) could add `path: "/etc/passwd"` or an `href` to an internal address, and nodemailer would read the file or fetch the URL and attach it. Attachments now carry only `filename`, `content` and `contentType`, and every message is composed with nodemailer's file and URL access disabled, on both the SMTP send and the IMAP append path.
