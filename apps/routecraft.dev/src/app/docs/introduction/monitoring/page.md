---
title: Monitoring
---

Log and observe routes. {% .lead %}

```ts
// plugins/observability.ts
import { logger } from '@routecraftjs/routecraft'

export default function observability(ctx) {
  ctx.on?.('routeStarted', (r) => logger.info('route started', { id: r.id }))
}
```

{% callout type="warning" title="TODO" %}
Event hooks on `CraftContext` are planned; for now use `onStartup`/`onShutdown` and logger.
{% /callout %}
