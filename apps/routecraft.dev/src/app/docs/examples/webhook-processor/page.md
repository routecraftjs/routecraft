---
title: Webhook Router
---

Receive webhooks and route different events to different destinations. {% .lead %}

```ts
import { craft, http, log, fetch } from '@routecraftjs/routecraft'

export default craft()
  .id('webhook-router')
  .from(http({ port: 3000, path: '/webhook', method: 'POST' }))
  .tap(log())
  .choice([
    {
      when: data => data.event === 'user.signup',
      then: craft().to(fetch({ 
        url: 'https://api.sendgrid.com/send-welcome' 
      }))
    },
    {
      when: data => data.event === 'payment',
      then: craft().to(fetch({ 
        url: 'https://analytics.company.com/track' 
      }))
    },
    {
      when: () => true,
      then: craft().tap(() => console.log('Unknown event'))
    }
  ])
```

## Input Data

HTTP POST requests to `http://localhost:3000/webhook`:

```json
{ "event": "user.signup", "data": { "email": "user@example.com" } }
{ "event": "payment", "data": { "amount": 100, "currency": "USD" } }
{ "event": "unknown.event", "data": { "foo": "bar" } }
```

## What It Does

1. Listens for POST requests at `/webhook` on port 3000
2. Logs all incoming webhook data
3. Routes events based on `event` field:
   - `user.signup` → sends to SendGrid API
   - `payment` → sends to Analytics API
   - Unknown events → logs to console

## Result

- **user.signup webhook** → HTTP POST to `https://api.sendgrid.com/send-welcome`
- **payment webhook** → HTTP POST to `https://analytics.company.com/track`  
- **unknown.event webhook** → Console log: "Unknown event"

All webhooks are also logged via `tap(log())`.
