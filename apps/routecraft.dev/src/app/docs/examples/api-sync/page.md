---
title: File to HTTP
---

Read a CSV file and send each row to an API. {% .lead %}

```ts
import { craft, csv, http } from '@routecraft/routecraft'

export default craft()
  .id('file-to-http')
  .from(csv({ path: './customers.csv', header: true }))
  .filter(row => row.status === 'active')
  .transform(row => ({
    name: row.first_name + ' ' + row.last_name,
    email: row.email,
  }))
  .to(http({
    url: 'https://api.example.com/users',
    method: 'POST',
  }))
```

## Input data

**customers.csv:**
```csv
first_name,last_name,email,status
John,Doe,john@test.com,active
Jane,Smith,jane@test.com,inactive
Bob,Wilson,bob@test.com,active
```

## What it does

1. Reads `customers.csv` with headers parsed as object keys
2. Filters to only `active` rows
3. Combines first and last name into a single `name` field
4. POSTs each transformed row to the API

## Result

Two HTTP POST requests sent to `https://api.example.com/users`:

```json
{ "name": "John Doe", "email": "john@test.com" }
{ "name": "Bob Wilson", "email": "bob@test.com" }
```

Jane is skipped because her status is `inactive`.
