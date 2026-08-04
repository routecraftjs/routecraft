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
| `restrict-principal-minting` | error | Principal minting (`.authenticate()`, `authenticate()`, `markAuthentic()`) is restricted to explicitly sanctioned sites (scoped disable comment or per-file override) | No |
| `capability-boundaries` | off (opt-in) | From outside a capability folder, import only its public-surface `route.ts`, never its internals | No |

## Presets

| Preset | Description |
|--------|-------------|
| `routecraftPlugin.configs.recommended` | Convention rules at their default levels, plus the security rule `restrict-principal-minting` as an error |
| `routecraftPlugin.configs.all` | Convention rules at their strictest levels, plus `restrict-principal-minting` as an error |

`capability-boundaries` is **not** in either preset. It encodes a specific repository layout
(`capabilities/<domain>/<capability>/route.ts`), so it is opt-in only and must be enabled
explicitly. See [Capability boundaries](/docs/advanced/linting#capability-boundaries-opt-in).

---

## Related

{% quick-links %}

{% quick-link title="Linting" icon="presets" href="/docs/advanced/linting" description="Install, configure, and customize rule severity." /%}

{% /quick-links %}
