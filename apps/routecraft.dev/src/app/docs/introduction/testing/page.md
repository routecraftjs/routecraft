---
title: Testing
---

Unit test routes and functions; E2E by running route files. {% .lead %}

```ts
import { describe, it, expect } from 'vitest'
import { craft, simple, log } from '@routecraftjs/routecraft'

describe('hello route', () => {
  it('builds with an id', () => {
    const r = craft()
      .from([{ id: 'x' }, simple('y')])
      .to(log())
    expect(r.build()[0].id).toBe('x')
  })
})
```
