---
title: File to HTTP
---

Read CSV file and send each row to an API. {% .lead %}

```ts
import { craft, csv, fetch } from '@routecraft/routecraft'

export default craft()
  .id('file-to-http')
  .from(csv({ path: './customers.csv', headers: true }))
  .filter(row => row.status === 'active')
  .transform(row => ({
    name: row.first_name + ' ' + row.last_name,
    email: row.email
  }))
  .to(fetch({
    url: 'https://api.example.com/users',
    method: 'POST'
  }))
```

## Input Data

**customers.csv:**
```csv
first_name,last_name,email,status
John,Doe,john@test.com,active
Jane,Smith,jane@test.com,inactive
Bob,Wilson,bob@test.com,active
```

## What It Does

1. Reads CSV file with headers
2. Filters to only `active` customers
3. Transforms each row to combine first/last name
4. Sends each transformed row to API via POST

## Result

Two HTTP POST requests sent to `https://api.example.com/users`:

```json
{ "name": "John Doe", "email": "john@test.com" }
{ "name": "Bob Wilson", "email": "bob@test.com" }
```

Jane is filtered out because her status is `inactive`.
