---
title: Routes
---

Keep one concern per file. {% .lead %}

```ts
// src/routes/index.route.ts
import { craft, simple, log } from '@routecraftjs/routecraft'

export default craft()
  .from([{ id: 'root' }, simple('RouteCraft alive')])
  .to(log())
```

Dynamic params (planned HTTP adapter):

```ts
// src/routes/users/[userId].route.ts
export default craft()
  .from([{ id: 'user-detail' } /* http inbound here */])
  .enrich(/* fetch using headers.params.userId */)
  .to(log())
```
