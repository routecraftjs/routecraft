---
title: Calendar & Meeting Assistant
---

Build an AI that can manage your calendar and schedule meetings. {% .lead %}

```ts
import { mcp } from '@routecraft/ai'
import { craft, noop } from '@routecraft/routecraft'
import { z } from 'zod'

// Tool 1: Check availability
craft()
  .id('check-availability')
  .from(mcp('check-availability', {
    description: 'Check calendar for available time slots',
    schema: z.object({
      date: z.string(),
      duration: z.number().describe('Meeting duration in minutes')
    }),
    keywords: ['calendar', 'availability', 'schedule']
  }))
  .process(async (exchange) => {
    const { date, duration } = exchange.body
    const events = await googleCalendar.getEvents(date)
    const freeSlots = findAvailableSlots(events, duration)
    return {
      ...exchange,
      body: {
        date,
        availableSlots: freeSlots,
        busyCount: events.length
      }
    }
  })
  .to(noop())

// Tool 2: Schedule meeting
craft()
  .id('schedule-meeting')
  .from(mcp('schedule-meeting', {
    description: 'Schedule a meeting and send calendar invites',
    schema: z.object({
      title: z.string(),
      attendees: z.array(z.string().email()),
      startTime: z.string(),
      duration: z.number(),
      location: z.string().optional()
    }),
    keywords: ['meeting', 'schedule', 'calendar', 'invite']
  }))
  .process(async (exchange) => {
    const { title, attendees, startTime, duration, location } = exchange.body
    const event = await googleCalendar.createEvent({
      summary: title,
      attendees: attendees.map(email => ({ email })),
      start: { dateTime: startTime },
      end: { dateTime: addMinutes(startTime, duration) },
      location
    })
    return {
      ...exchange,
      body: {
        created: true,
        eventId: event.id,
        link: event.htmlLink
      }
    }
  })
  .to(noop())

// Tool 3: Get today's agenda
craft()
  .id('todays-agenda')
  .from(mcp('todays-agenda', {
    description: 'Get summary of today\'s meetings and events',
    keywords: ['calendar', 'agenda', 'today', 'schedule']
  }))
  .process(async (exchange) => {
    const today = new Date().toISOString().split('T')[0]
    const events = await googleCalendar.getEvents(today)
    return {
      ...exchange,
      body: {
        date: today,
        eventCount: events.length,
        events: events.map(e => ({
          time: e.start.dateTime,
          title: e.summary,
          attendees: e.attendees?.length || 0
        }))
      }
    }
  })
  .to(noop())
```

## MCP Configuration

Add to Claude Desktop or Cursor config:

```json
{
  "mcpServers": {
    "calendar-assistant": {
      "command": "npx",
      "args": [
        "@routecraft/cli",
        "run",
        "./routes/calendar-tools.mjs"
      ]
    }
  }
}
```

## Usage in Claude

Natural language calendar management:

**User:** "Am I free tomorrow at 2pm for a 30 minute call?"

**Claude:** (Checks availability, reports back)

**User:** "Schedule a team sync with john@example.com and sarah@example.com for next Tuesday at 10am"

**Claude:** (Finds available slot, creates meeting, sends invites)

**User:** "What's on my calendar today?"

**Claude:** (Gets today's agenda, summarizes meetings)

## What Makes This Secure

- AI can **only** perform these specific calendar actions
- No arbitrary calendar access or deletion
- Input validated with Zod schemas
- You control which calendars are accessible
- All actions are logged and auditable

## Setup Requirements

### Google Calendar API

```bash
# Install dependencies
npm install googleapis

# Set environment variables
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token
```

### Microsoft Outlook/O365

```bash
# Install dependencies
npm install @microsoft/microsoft-graph-client

# Set environment variables
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
AZURE_TENANT_ID=your-tenant-id
```

## Use Cases

- **Meeting coordination** - Find times, send invites automatically
- **Daily briefings** - "What's on my calendar today?"
- **Travel planning** - Block travel time, add flight details
- **Availability checks** - Quick responses to scheduling requests
- **Recurring meetings** - Set up weekly syncs with teams
