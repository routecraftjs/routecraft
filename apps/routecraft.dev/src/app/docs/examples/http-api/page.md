---
title: HTTP Server
---

Create a simple REST API endpoint that processes requests. {% .lead %}

{% callout type="warning" %}
This example shows the **planned inbound/server HTTP API**. The currently shipped `http()` adapter is for outbound/client requests only. Treat this page as design reference and check the [Adapters documentation](/docs/reference/adapters) for current vs planned HTTP support.
{% /callout %}

```ts
import { craft, http, log } from '@routecraft/routecraft'

export default craft()
  .id('http-server')
  .from(http({ 
    port: 3000, 
    path: '/users', 
    method: 'POST' 
  }))
  .process(request => ({
    id: Date.now(),
    name: request.name,
    email: request.email,
    status: 'created'
  }))
  .tap(log())
```

## Input Data

HTTP POST requests to `http://localhost:3000/users`:

```json
{ "name": "John Doe", "email": "john@example.com" }
{ "name": "Jane Smith", "email": "jane@example.com" }
```

## What It Does

1. Listens for POST requests at `/users` on port 3000
2. Processes each request to add ID and status
3. Logs the response data
4. Returns the processed data as HTTP response

## Result

HTTP responses sent back to clients:

```json
{ "id": 1705312800123, "name": "John Doe", "email": "john@example.com", "status": "created" }
{ "id": 1705312801456, "name": "Jane Smith", "email": "jane@example.com", "status": "created" }
```

Each request gets a unique timestamp ID and `created` status.
