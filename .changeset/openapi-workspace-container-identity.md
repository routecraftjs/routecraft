---
"@routecraft/routecraft": patch
---

Stop the http plugin's OpenAPI auto-detection from advertising a workspace container's identity.

`findPackageInfo` now yields nothing when the nearest `package.json` is a monorepo root (it declares a `workspaces` field, or a `pnpm-workspace.yaml` sits beside it), so `/openapi.json` serves the neutral fallbacks `Routecraft HTTP API` / `0.0.0` instead of the container's private, often stale `name` / `version`. A workspace container is repository infrastructure, not a service identity: release tooling never versions it, so its `version` drifts, and its metadata must not leak through a publicly served document. Apps run from their own directory are unaffected, `private: true` manifests without workspaces still auto-detect as before, and `builtins.openapi.info` continues to override everything.
