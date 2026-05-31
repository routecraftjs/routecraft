---
title: cron
---

[← All adapters](/docs/reference/adapters) {% .lead %}

```ts
cron(expression: string, options?: CronOptions): Source<undefined>
```

Trigger routes on a cron schedule with timezone support. Produces `undefined` as the message body. More expressive than `timer()` for complex recurring schedules.

Supports standard 5-field cron (minute granularity), extended 6-field (second granularity), and nicknames (`@daily`, `@weekly`, `@hourly`, `@monthly`, `@yearly`, `@annually`, `@midnight`).

```ts
// Every 5 minutes
.id('poller')
.from(cron('*/5 * * * *'))

// Weekdays at 9am Eastern
.id('morning-report')
.from(cron('0 9 * * 1-5', { timezone: 'America/New_York' }))

// Daily at midnight (nickname)
.id('nightly-cleanup')
.from(cron('@daily'))

// Every 30 seconds (6-field)
.id('health-check')
.from(cron('*/30 * * * * *'))

// First day of month, limited to 12 fires
.id('monthly-report')
.from(cron('@monthly', { maxFires: 12, name: 'monthly-report' }))

// With jitter to prevent thundering herd
.id('distributed-poll')
.from(cron('*/5 * * * *', { jitterMs: 5000 }))

// Run only during Q1 2026
.id('q1-campaign')
.from(cron('@daily', { startAt: '2026-01-01', stopAt: '2026-04-01' }))
```

Options:

| Field | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `timezone` | `string` | System local | No | IANA timezone (e.g., `"America/New_York"`, `"UTC"`) |
| `maxFires` | `number` | `Infinity` | No | Maximum number of fires before stopping (delegated to croner's `maxRuns`) |
| `jitterMs` | `number` | `0` | No | Random delay in milliseconds added to each fire |
| `name` | `string` | -- | No | Human-readable job name for observability |
| `protect` | `boolean` | `true` | No | Prevents overlapping handler execution when the previous run is still in progress |
| `startAt` | `Date \| string` | -- | No | Date or ISO 8601 string at which the cron job should start running |
| `stopAt` | `Date \| string` | -- | No | Date or ISO 8601 string at which the cron job should stop running |

**Cron expression format:**

| Format | Example | Description |
| --- | --- | --- |
| 5-field | `*/5 * * * *` | minute, hour, day-of-month, month, day-of-week |
| 6-field | `*/30 * * * * *` | second, minute, hour, day-of-month, month, day-of-week |
| Nickname | `@daily` | Predefined schedule |

**Supported nicknames:** `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` / `@midnight`, `@hourly`

**Headers added:** Cron metadata including expression, fired time, counter, next run, timezone, and name (via `routecraft.cron.*` headers)
