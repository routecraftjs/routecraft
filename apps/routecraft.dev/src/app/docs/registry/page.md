---
title: Registry
---

Install community capabilities in one command. {% .lead %}

The **Routecraft Registry** is an open-source repository of reusable capabilities that you can install with `craft add`. Every capability is SHA-verified by CI before it reaches you.

---

## Quick start

```bash
pnpm craft add elastic-logs
```

That single command:

1. Fetches the capability from the registry
2. Verifies its SHA-256 against the CI-computed hash
3. Installs any required capabilities recursively
4. Runs `pnpm add` for all declared dependencies
5. Updates your `index.ts` with the new import
6. Prints any required environment variables

---

## How it works

The registry lives at [routecraftjs/routecraft-registry](https://github.com/routecraftjs/routecraft-registry) on GitHub. Each capability is a directory with two files:

```
capabilities/elastic-logs/1.0.0/
  craft.yml           # manifest: metadata, deps, env vars
  elastic-logs.mjs    # the capability file
```

### Trust model

Capabilities are **not trusted by default**. The registry CI pipeline validates every submission:

1. **Schema validation**: required fields, valid semver, valid type
2. **Static analysis**: no `eval()`, no `child_process`, no filesystem writes
3. **Immutability**: once a version is merged, its content cannot change
4. **SHA-256 hash**: computed by CI, never by the author

When you run `craft add`, the CLI fetches the file and computes its hash locally. If it does not match the registry hash, the install is rejected. This means even if the raw file host is compromised, tampered files are caught.

```
pnpm craft add elastic-logs@1.0.0

# If the file was modified after registration:
# SHA verification failed: elastic-logs@1.0.0
#    Expected:  3a4b5c6d...
#    Received:  9f8e7d6c...
```

---

## The craft.yml manifest

Every registry entry includes a `craft.yml` manifest:

```yaml
type: capability
id: elastic-logs
name: Elasticsearch Log Fetcher
version: 1.0.0
description: >
  Fetches logs from Elasticsearch for a given traceId. Returns structured
  log entries and a summary. Use when investigating an incident with a trace ID.
author: routecraftjs
license: Apache-2.0
tags:
  - observability
  - elasticsearch
dependencies:
  "@routecraft/routecraft": "^0.4.0"
  "zod": "^3.0.0"
requiredCapabilities:
  - history-search@1.0.0
env:
  - ELASTIC_URL
  - ELASTIC_INDEX
  - ELASTIC_API_KEY
```

| Field | Required | Description |
| --- | --- | --- |
| type | Yes | `capability`, `agent`, `skill`, or `example` |
| id | Yes | Lowercase, hyphen-separated unique identifier |
| version | Yes | Semantic version (immutable once merged) |
| description | Yes | What the capability does and when to use it |
| author | No | Author or organization name |
| license | No | SPDX license identifier |
| tags | No | Discovery tags |
| dependencies | No | npm packages to install (package name to version range) |
| requiredCapabilities | No | Other registry capabilities this one depends on |
| env | No | Environment variable names the capability requires |
| sha256 | No | Computed by CI. Never authored manually. |

The same manifest format is used for all types. The `type` field is used for routing and display only.

---

## Installing capabilities

### Basic usage

```bash
# Latest version
pnpm craft add elastic-logs

# Specific version
pnpm craft add elastic-logs@1.0.0

# Custom registry (e.g. your company's private registry)
pnpm craft add elastic-logs --registry https://registry.acme.com --allow-unofficial

# Custom target directory
pnpm craft add elastic-logs --dir ./packages/my-service/capabilities

# Skip index.ts update
pnpm craft add elastic-logs --no-index
```

### Required capabilities

If a capability declares `requiredCapabilities`, they are installed automatically. Required capabilities always resolve to the latest available version:

```
pnpm craft add elastic-logs

elastic-logs@1.0.0 -> capabilities/elastic-logs.mjs
history-search@2.0.0 -> capabilities/history-search.mjs  (required by elastic-logs)
dependencies installed
index.ts updated

   Required env vars:
     ELASTIC_URL
     ELASTIC_INDEX
     ELASTIC_API_KEY
```

Circular dependencies are detected and rejected.

---

## Submitting a capability

1. Fork [routecraftjs/routecraft-registry](https://github.com/routecraftjs/routecraft-registry)
2. Create a directory: `capabilities/<your-id>/<version>/`
3. Add your capability file (`<your-id>.mjs`) and a `craft.yml`
4. Open a pull request targeting `main`
5. CI validates, scans, and computes the SHA automatically
6. Once reviewed and merged, it is available to everyone via `craft add`

{% callout type="warning" title="Versions are immutable" %}
Once a version is merged, its content cannot be changed. To ship a fix, publish a new version (e.g. `1.0.1`) in a separate directory.
{% /callout %}

---

## Running a private registry

The `craft add` command works with any static file server that serves the same directory structure as the public registry. To run a private registry:

1. Create a repository with the same layout (`capabilities/<id>/<version>/`)
2. Include `registry/capabilities.json` with SHA entries
3. Use the `--registry` and `--allow-unofficial` flags

```bash
pnpm craft add my-internal-cap --registry https://registry.internal.acme.com --allow-unofficial
```

The CI scripts (`scripts/validate-manifest.js`, `scripts/compute-sha.js`, `scripts/scan-static.js`) are open source under Apache 2.0 and can be reused in your own CI pipeline.

---

## Agents and skills

{% callout type="note" title="Coming soon" %}
The registry format supports `agent` and `skill` types in the manifest, but `craft add` currently only handles capabilities. Agent and skill support will ship in a future release. The manifest format will not change. Agents and skills define their persona, tool scope, and instructions in the capability file itself.
{% /callout %}

---

## Related

{% quick-links %}

{% quick-link title="CLI Reference" icon="installation" href="/docs/reference/cli" description="Full craft add flag documentation." /%}
{% quick-link title="Capabilities" icon="plugins" href="/docs/introduction/capabilities" description="Learn how capabilities work." /%}
{% quick-link title="Community" icon="lightbulb" href="/docs/community" description="Links to the registry, awesome-routecraft, and more." /%}

{% /quick-links %}
