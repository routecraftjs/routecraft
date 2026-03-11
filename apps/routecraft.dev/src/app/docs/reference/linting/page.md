---
title: Linting
---

Rule catalog for `@routecraft/eslint-plugin-routecraft`. {% .lead %}

## Rules

| Rule | Default | Description | Autofix |
|------|---------|-------------|---------|
| `require-named-route` | error | Every `craft()` chain must call `.id(<non-empty string>)` before `.from()` | No |
| `batch-before-from` | warn | `.batch()` must appear before `.from()` -- using it after has no effect on the current route | No |
| `error-before-from` | warn | `.error()` must appear before `.from()` -- using it after has no effect on the current route | No |
| `mcp-server-options` | error | `mcp()` used as a source in `.from()` must include a `description` for AI discoverability | No |

## Presets

| Preset | Description |
|--------|-------------|
| `routecraftPlugin.configs.recommended` | All rules at their default levels |
| `routecraftPlugin.configs.all` | All rules as errors |

---

## Related

{% quick-links %}

{% quick-link title="Linting" icon="presets" href="/docs/advanced/linting" description="Install, configure, and customize rule severity." /%}

{% /quick-links %}
