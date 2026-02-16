---
title: Email Assistant
---

Build an AI assistant that can send and manage emails. {% .lead %}

```ts
import { craft, tool, fetch } from '@routecraft/routecraft'
import { z } from 'zod'

// Tool 1: Send email
export default craft()
  .id('send-email')
  .from(tool('send-email', {
    description: 'Send an email with subject and body',
    schema: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
      cc: z.array(z.string().email()).optional()
    }),
    keywords: ['email', 'send', 'communication']
  }))
  .process(async ({ to, subject, body, cc }) => {
    // Use SendGrid, Resend, or your email service
    await sendGrid.send({
      to,
      subject,
      text: body,
      cc
    })
    return {
      sent: true,
      to,
      timestamp: new Date().toISOString()
    }
  })
  .to(noop())

// Tool 2: Check unread emails
craft()
  .id('check-inbox')
  .from(tool('check-inbox', {
    description: 'Get count of unread emails and recent senders',
    keywords: ['email', 'inbox', 'unread']
  }))
  .process(async () => {
    const unread = await gmail.getUnread()
    return {
      count: unread.length,
      recentSenders: unread.slice(0, 5).map(e => e.from)
    }
  })
  .to(noop())
```

## MCP Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "email-assistant": {
      "command": "npx",
      "args": [
        "@routecraft/cli",
        "run",
        "./routes/email-tools.mjs"
      ],
      "env": {
        "SENDGRID_API_KEY": "your-key-here"
      }
    }
  }
}
```

## Usage Examples

Once configured, Claude can handle your emails naturally:

**User:** "Send an email to john@example.com thanking him for yesterday's meeting"

**Claude:** (Calls send-email tool with appropriate subject and body)

**User:** "Do I have any urgent emails?"

**Claude:** (Calls check-inbox, analyzes senders, reports back)

## What Makes This Powerful

- **Natural language to email** - AI composes appropriate messages
- **Context aware** - AI remembers conversation context
- **Safe defaults** - You control which addresses can receive emails
- **Auditable** - Every email send is logged in your code

## Environment Variables

```bash
# .env file
SENDGRID_API_KEY=your-sendgrid-key
# or
RESEND_API_KEY=your-resend-key
# or use Gmail API
GMAIL_CLIENT_ID=your-client-id
GMAIL_CLIENT_SECRET=your-secret
```

## Use Cases

- Quick email responses while mobile
- Email summarization and prioritization
- Automated follow-ups
- Newsletter unsubscribe automation
- Receipt and document forwarding
