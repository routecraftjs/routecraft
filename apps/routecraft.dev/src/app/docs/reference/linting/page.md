---
title: Linting
---

Rule catalog for `@routecraft/eslint-plugin-routecraft`. {% .lead %}

## Rules

| Rule | Default | Description | Autofix |
|------|---------|-------------|---------|
| `require-named-route` | error | Every `craft()` chain must call `.id(<non-empty string>)` before `.from()` | No |
| `batch-before-from` | warn | `.batch()` must appear before `.from()` -- using it after has no effect on the current route | No |
| `single-to-per-route` | warn | Each `craft()` chain should have at most one `.to()`; extra outputs belong in `.tap()` | No |
| `capability-boundaries` | off (opt-in) | From outside a capability folder, import only its public-surface `route.ts`, never its internals | No |

## Presets

| Preset | Description |
|--------|-------------|
| `routecraftPlugin.configs.recommended` | The convention rules at their default levels |
| `routecraftPlugin.configs.all` | The convention rules as errors |

`capability-boundaries` is **not** in either preset. It encodes a specific repository layout
(`capabilities/<domain>/<capability>/route.ts`), so it is opt-in only and must be enabled
explicitly. See [Capability boundaries](/docs/advanced/linting#capability-boundaries-opt-in).

---

## Related

{% quick-links %}

{% quick-link title="Linting" icon="presets" href="/docs/advanced/linting" description="Install, configure, and customize rule severity." /%}

{% /quick-links %}
