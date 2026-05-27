---
title: Operations
---

Every verb in the Routecraft DSL. Each row opens its own reference page with the full signature, options, and examples. {% .lead %}

```ts
craft()
  .id('my-route')
  .from(simple('x'))
  .filter((s) => s.length > 0)
  .transform((s) => s + '!')
  .to(log())
```

{% operations-index /%}

## Related

{% quick-links %}

{% quick-link title="Adapters" icon="installation" href="/docs/reference/adapters" description="Sources, destinations, and transformers that connect operations to the outside world." /%}
{% quick-link title="Events" icon="presets" href="/docs/reference/events" description="The lifecycle events emitted around every operation." /%}
{% quick-link title="Errors" icon="theming" href="/docs/reference/errors" description="Error codes raised by operations and how to recover them." /%}

{% /quick-links %}
