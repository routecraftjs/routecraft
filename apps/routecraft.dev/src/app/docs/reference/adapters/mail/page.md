---
title: mail
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
mail(folder: string, options: Partial<MailServerOptions>): Source<MailBody>
mail(folder: string): Destination<unknown, MailFetchResult>
mail(options: Partial<MailServerOptions>): Destination<unknown, MailFetchResult>
mail(action: MailAction): Destination<unknown, void>
mail(options?: Partial<MailClientOptions>): Destination<MailSendPayload, MailSendResult>
```

Read email via IMAP, send via SMTP, or perform IMAP operations. The adapter has four modes determined by the arguments you pass.

**Source mode (IMAP push):** Pass a folder and options to receive new messages via IMAP IDLE or polling. Each new email becomes a separate exchange.

The source follows the payload-on-`body`, envelope-on-`headers` convention shared with the HTTP source: the parsed message content (`text`, `html`, `attachments`) lands on `exchange.body` (a [`MailBody`](#mailbody-source-exchange-body)), and the envelope (from, to, subject, date, flags, sender, ...) lands on [`routecraft.mail.*` headers](#source-headers). This means `.input({ body })` validates against the message content alone, and the same `.transform()` / `.filter()` operators compose whether the payload arrived over mail or HTTP.

```ts
craft()
  .id('inbox-watcher')
  .from(mail('INBOX', { markSeen: true }))
  .to(log())

// Read the envelope off headers, the content off the body.
craft()
  .id('inbox-router')
  .from(mail('INBOX', { markSeen: true }))
  .filter((ex) => ex.headers['routecraft.mail.from']?.endsWith('@acme.test') ?? false)
  .transform((body) => body.text ?? '')
  .to(log())
```

**Source delivery modes:** the source runs in one of two modes.

- **IDLE (default):** the server pushes notifications when new mail arrives. The `\Seen` flag is the cross-cycle dedupe state, so each message is delivered exactly once per subscription. IDLE is the right default for "process each new email once" workloads. If the IMAP connection drops mid-subscription the source reconnects automatically with exponential backoff; auth failures stop the subscription immediately.
- **Poll (opt-in):** set `pollIntervalMs` to fetch on a cadence instead of IDLE. Required whenever you opt out of the `\Seen` dedupe model (`markSeen: false` or `unseen: false`), for example to re-evaluate the inbox on every cycle and rely on a folder move as the done-signal. IDLE has no cycle boundary, so combining it with those overrides would refetch the entire folder on every inbound message; the source throws `RC5003` at startup to prevent this footgun.

```ts
// Re-evaluate the inbox every minute; archive a message to mark it done.
// If you later extend `matchesCriteria`, previously-unmatched mail that is
// still in INBOX is picked up on the next cycle.
craft()
  .id('inbox-processor')
  .from(mail('INBOX', {
    pollIntervalMs: 60_000,
    markSeen: false,
    unseen: false,
  }))
  .filter(matchesCriteria)
  .process(processMessage)
  .to(mail({ action: 'move', folder: 'Archive' }))
```

The `\Seen` flag is written per-message **after** the handler resolves successfully, so a downstream failure leaves the message un-Seen and it is retried on the next cycle. `limit` combined with IDLE is a latency trap (backlog beyond the limit only drains when new mail arrives) and emits a warning at subscribe time.

**Fetch destination (IMAP pull):** Pass a folder string or server options to fetch messages. Use with `.enrich()` to pull mail on demand.

```ts
craft()
  .id('check-inbox')
  .from(cron('0 */5 * * * *'))
  .enrich(mail('INBOX'))
  .to(log())
```

**Send destination (SMTP):** Call with no arguments or client options to send email. The exchange body must be a `MailSendPayload`.

```ts
craft()
  .id('outbound')
  .from(direct())
  .to(mail())
```

**Combined read and send:**

```ts
// Forward unread mail to a different address. The incoming subject is on
// headers (envelope); the text content is on the body (payload).
craft()
  .id('mail-forwarder')
  .from(mail('INBOX', { unseen: true, markSeen: true }))
  .transform((body, ex) => ({
    to: 'team@example.com',
    subject: `Fwd: ${ex.headers['routecraft.mail.subject']}`,
    text: body.text ?? '',
  }))
  .to(mail())
```

**IMAP operations:** Call with a `MailAction` object to move, copy, delete, flag, unflag, or append messages.

```ts
// Archive after processing
craft()
  .id('archive-processed')
  .from(mail('INBOX', { unseen: true }))
  .tap(processMessage)
  .to(mail({ action: 'move', folder: 'Archive' }))

// Flag important messages
craft()
  .id('flag-important')
  .from(mail('INBOX', { subject: 'URGENT' }))
  .to(mail({ action: 'flag', flags: '\\Flagged' }))
```

**Configuration via named accounts:**

Mail connection details are set once in your `craft.config.ts` so individual routes do not need to repeat them. Each capability file re-exports the config:

```ts
// craft.config.ts
import type { CraftConfig } from '@routecraft/routecraft'

export const craftConfig: CraftConfig = {
  mail: {
    accounts: {
      default: {
        imap: {
          host: 'imap.gmail.com',
          auth: { user: process.env.MAIL_USER!, pass: process.env.MAIL_APP_PASSWORD! },
        },
        smtp: {
          host: 'smtp.gmail.com',
          auth: { user: process.env.MAIL_USER!, pass: process.env.MAIL_APP_PASSWORD! },
          from: process.env.MAIL_USER!,
        },
      },
    },
  },
}
```

```ts
// capabilities/inbox-watcher.ts
export { craftConfig } from '../craft.config'
import { craft, mail, log } from '@routecraft/routecraft'

export default craft()
  .id('inbox-watcher')
  .from(mail('INBOX', { markSeen: true }))
  .to(log())
```

When multiple accounts are configured, select one per adapter call with the `account` option:

```ts
.from(mail('INBOX', { account: 'support' }))
.to(mail({ account: 'notifications' }))
```

**Server options (`MailServerOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | | IMAP host (e.g. `'imap.gmail.com'`) |
| `port` | `number` | `993` | IMAP port |
| `secure` | `boolean` | `true` | Use TLS |
| `auth` | `MailAuth` | | `{ user, pass }` credentials |
| `folder` | `string` | `'INBOX'` | IMAP mailbox folder |
| `markSeen` | `boolean` | `true` | Mark fetched messages as seen |
| `since` | `Date` | | Only fetch messages since this date |
| `unseen` | `boolean` | `true` | Only fetch unseen messages |
| `from` | `string \| string[]` | | Filter by sender (IMAP FROM search). Array = OR |
| `to` | `string \| string[]` | | Filter by recipient (IMAP TO search). Array = OR |
| `subject` | `string \| string[]` | | Filter by subject text (IMAP SUBJECT search). Array = OR |
| `body` | `string \| string[]` | | Filter by body text (IMAP TEXT search). Array = OR |
| `header` | `Record<string, string \| string[]>` | | Filter by arbitrary IMAP headers. Array values = OR |
| `includeHeaders` | `true \| string[]` | | Raw headers to include on fetched messages. `true` = all |
| `verify` | `'off' \| 'headers' \| 'strict'` | `'headers'` | Sender analysis. `'headers'` reads `Authentication-Results`/`ARC`/`List-Id` the receiving server wrote (no network). `'strict'` additionally runs cryptographic verification via optional `mailauth` (DNS lookups). `'off'` skips analysis. |
| `limit` | `number` | | Maximum messages per fetch |
| `pollIntervalMs` | `number` | | Poll interval in ms (default: IMAP IDLE) |
| `account` | `string` | | Named account from context config (uses default if omitted) |
| `onParseError` | `'fail' \| 'abort' \| 'drop'` | `'fail'` | How to handle a per-message MIME parse failure. See [parse error handling](/docs/reference/adapters#parse-error-handling). All three modes mark the malformed message Seen so it does not refetch forever. `'fail'` routes the failure through the route's `.error()` handler (or `exchange:failed` if no handler is set). `'drop'` does NOT invoke `.error()`; it emits `exchange:dropped` with `reason: 'parse-failed'` so subscribers can count parse drops as a structured event without scraping logs. Pre-#187 behaviour was equivalent to a silent `'drop'` (logged at debug, no event); set `onParseError: 'drop'` to keep lossy-ingest semantics with structured observability. |

**Client options (`MailClientOptions`):**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | | SMTP host (e.g. `'smtp.gmail.com'`) |
| `port` | `number` | `465` | SMTP port |
| `secure` | `boolean` | `true` | Use TLS |
| `auth` | `MailAuth` | | `{ user, pass }` credentials |
| `from` | `string` | | Default sender address |
| `replyTo` | `string` | | Default reply-to address |
| `cc` | `string \| string[]` | | Default CC recipients |
| `bcc` | `string \| string[]` | | Default BCC recipients |
| `account` | `string` | | Named account from context config (uses default if omitted) |

**`MailBody` (source exchange body):** {% #mailbody-source-exchange-body %}

In source mode (`.from(mail(...))`) the exchange **body** is just the parsed message content. The envelope lives on [headers](#source-headers).

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string?` | Plain text body, when the message included a `text/plain` part. |
| `html` | `string?` | HTML body, when the message included a `text/html` part. |
| `attachments` | `MailAttachment[]?` | File attachments. Attachments are message content (not envelope), so they stay on the body alongside `text`/`html`, mirroring how the HTTP source keeps multipart files on the body. |

**Source headers (`routecraft.mail.*`):** {% #source-headers %}

In source mode the envelope is attached to `exchange.headers` under the `routecraft.mail.*` namespace. The keys are declaration-merged into `RoutecraftHeaders` (so you get autocomplete) and exported on the `MailHeaders` key object (`MailHeaders.FROM`, `MailHeaders.SUBJECT`, ...).

| Header | Type | Description |
|--------|------|-------------|
| `routecraft.mail.uid` | `number` | IMAP UID |
| `routecraft.mail.folder` | `string` | The IMAP folder this message was fetched from |
| `routecraft.mail.messageId` | `string` | Message-ID header |
| `routecraft.mail.from` | `string` | Literal `From:` header. For mailing-list forwards this is the rewritten list address; use `routecraft.mail.sender` for the real sender. |
| `routecraft.mail.to` | `string[]` | Recipient address(es), always normalised to an array |
| `routecraft.mail.cc` | `string[]?` | CC recipients (absent when none) |
| `routecraft.mail.bcc` | `string[]?` | BCC recipients (absent when none) |
| `routecraft.mail.subject` | `string` | Subject line |
| `routecraft.mail.date` | `Date` | Date sent |
| `routecraft.mail.replyTo` | `string?` | Reply-to address |
| `routecraft.mail.flags` | `ReadonlySet<string>` | IMAP flags (e.g. `\Seen`, `\Flagged`) |
| `routecraft.mail.sender` | `MailSender?` | Computed effective sender and forward chain (see below). Absent when `verify: 'off'`. |
| `routecraft.mail.rawHeaders` | `Record<string, string \| string[]>?` | Raw email headers (when `includeHeaders` is set) |

**`MailMessage` (fetch destination result):**

In fetch mode (`.enrich(mail(...))`) the result body is a `MailMessage[]`. Because a batch fetch returns many messages, each one keeps its whole envelope together in a single object rather than splitting across single-valued headers.

| Field | Type | Description |
|-------|------|-------------|
| `uid` | `number` | IMAP UID |
| `messageId` | `string` | Message-ID header |
| `from` | `string` | Literal `From:` header. For mailing-list forwards this is the rewritten list address; use `sender.address` for the real sender. |
| `to` | `string \| string[]` | Recipient address(es) |
| `subject` | `string` | Subject line |
| `date` | `Date` | Date sent |
| `body` | `{ text?: string; html?: string }` | Message body. Both, either, or neither may be populated depending on what the sender composed (`multipart/alternative` vs single-part). |
| `cc` | `string[]?` | CC recipients |
| `bcc` | `string[]?` | BCC recipients |
| `replyTo` | `string?` | Reply-to address |
| `attachments` | `MailAttachment[]?` | File attachments |
| `rawHeaders` | `Record<string, string \| string[]>?` | Raw email headers (when `includeHeaders` is set) |
| `flags` | `Set<string>` | IMAP flags (e.g. `\Seen`, `\Flagged`) |
| `folder` | `string` | The IMAP folder this message was fetched from |
| `sender` | `MailSender?` | Computed effective sender and forward chain (see below). Omitted when `verify: 'off'`. |

**`MailSender` (on `routecraft.mail.sender` / `MailMessage.sender`):**

Resolves the *real* sender of mailing-list and auto-forwarded messages, so apps can gate on origin without re-parsing headers. For a Google Groups forward, `sender.address` is the original sender and `from` is the rewritten list address.

| Field | Type | Description |
|-------|------|-------------|
| `address` | `string` | Effective sender address, after unwinding list / auto-forward rewrites. |
| `name` | `string?` | Display name, when present. |
| `domain` | `string` | Domain portion of `address`. |
| `forwardType` | `'direct' \| 'auto-forward' \| 'mailing-list'` | How the message reached the recipient. |
| `forwardChain` | `ForwardHop[]` | Hops between original sender and final recipient, nearest hop first. Empty for direct mail. |
| `trust` | `'verified' \| 'unverified' \| 'failed'` | Trust state. Direct mail is `verified` when `dmarc=pass`; forwarded mail is `verified` when `ARC cv=pass`. |
| `reason` | `string` | Machine-readable slug (e.g. `'list-forward-arc-verified'`, `'direct-dmarc-aligned'`). |
| `authentication` | `{ dkim, spf, dmarc, arc }` | Per-method verdicts (`pass` / `fail` / `neutral` / `none`; ARC is `pass` / `fail` / `none`). |
| `headerFrom` | `EmailAddress?` | Literal `From:` header, only set when it differs from the effective sender. |

**Filter on the effective sender:**

```ts
craft()
  .from(mail('INBOX'))
  .filter((ex) => {
    const s = ex.headers['routecraft.mail.sender'];
    if (s?.address === 'alice@allowed.com' && s.trust === 'verified') {
      return true;
    }
    return { reason: s?.reason ?? 'no sender info' };
  })
  .to(log())
```

**`MailSendPayload` (exchange body for `.to(mail())`):**

| Field | Type | Description |
|-------|------|-------------|
| `to` | `string \| string[]` | Recipient address(es) |
| `subject` | `string` | Subject line |
| `text` | `string?` | Plain text body |
| `html` | `string?` | HTML body |
| `cc` | `string \| string[]?` | CC recipients |
| `bcc` | `string \| string[]?` | BCC recipients |
| `from` | `string?` | Sender (overrides option-level `from`) |
| `replyTo` | `string?` | Reply-to (overrides option-level `replyTo`) |
| `inReplyTo` | `string?` | `Message-ID` of the message being replied to. Sets `In-Reply-To` and, when `references` is not set, also seeds `References` so mail clients stitch the thread. The inbound side exposes the value as the `routecraft.mail.messageId` header |
| `references` | `string \| string[]?` | Explicit `References` chain (oldest first). Overrides the chain derived from `inReplyTo` |
| `headers` | `Record<string, string>?` | Custom RFC 5322 headers on the outgoing message (e.g. `X-Auto-Response-Suppress`). The threading fields above win over the same keys given here |
| `attachments` | `Array<{ filename, content, contentType? }>?` | File attachments |

**`MailSendResult`:**

| Field | Type | Description |
|-------|------|-------------|
| `messageId` | `string` | Message-ID of the sent email |
| `accepted` | `string[]` | Accepted recipient addresses |
| `rejected` | `string[]` | Rejected recipient addresses |
| `response` | `string` | SMTP server response string |

**Exported types:** `MailAuth`, `MailServerOptions`, `MailClientOptions`, `MailOptions`, `MailBody`, `MailMessage`, `MailAttachment`, `MailSendPayload`, `MailSendResult`, `MailFetchResult`, `MailContextConfig`, `MailAccountConfig`, `MailAction`, `MailSender`, `EmailAddress`, `ForwardHop`, `ForwardType`, `TrustLevel`, `MailClientManager`, `MAIL_CLIENT_MANAGER`. Header keys: the `MailHeaders` object (`UID`, `FOLDER`, `MESSAGE_ID`, `FROM`, `TO`, `CC`, `BCC`, `SUBJECT`, `DATE`, `REPLY_TO`, `FLAGS`, `SENDER`, `RAW_HEADERS`). Helpers: `analyzeHeaders`, `parseAuthResults`.

---
