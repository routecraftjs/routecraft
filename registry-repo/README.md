# routecraft-registry

The official community registry for [Routecraft](https://github.com/routecraftjs/routecraft) capabilities, agents, skills, and examples.

## Overview

This repository hosts reusable capabilities that can be installed with a single command:

```bash
pnpm craft add elastic-logs
```

Every submission is validated by CI before it reaches users: schema checks, static analysis, immutability enforcement, and SHA-256 hashing.

## Directory structure

```
capabilities/           # Capability entries
  elastic-logs/
    1.0.0/
      craft.yml         # Manifest (metadata, deps, env vars)
      elastic-logs.mjs  # Capability file
agents/                 # Agent entries
skills/                 # Skill entries
examples/               # Example project entries
registry/               # CI-generated JSON indexes
  capabilities.json
  agents.json
  skills.json
  examples.json
scripts/                # CI validation and hashing scripts
```

## Submitting a capability

1. Fork this repository
2. Create a directory: `capabilities/<your-id>/<version>/`
3. Add your capability file (`<your-id>.mjs`) and a `craft.yml` manifest
4. Open a pull request targeting `main`
5. CI validates, scans, and computes the SHA-256 automatically
6. Once reviewed and merged, it is available via `pnpm craft add <your-id>`

## The craft.yml manifest

```yaml
type: capability
id: elastic-logs
name: Elasticsearch Log Fetcher
version: 1.0.0
description: >
  Fetches logs from Elasticsearch for a given traceId.
author: routecraftjs
license: Apache-2.0
tags:
  - observability
  - elasticsearch
dependencies:
  "@routecraft/routecraft": "^0.4.0"
requiredCapabilities:
  - history-search@1.0.0
env:
  - ELASTIC_URL
  - ELASTIC_API_KEY
```

| Field | Required | Description |
|-------|----------|-------------|
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

## Trust model

Capabilities are not trusted by default. The CI pipeline validates every submission:

1. **Schema validation**: required fields, valid semver, valid type
2. **Static analysis**: no `eval()`, no `child_process`, no filesystem writes
3. **Immutability**: once a version is merged, its content cannot change
4. **SHA-256 hash**: computed by CI, never by the author

When `craft add` runs, the CLI computes the file's hash locally and compares it to the CI-computed hash in `registry/capabilities.json`. Tampered files are rejected.

## Versions are immutable

Once a version is merged, its content cannot be changed. To ship a fix, publish a new version (e.g. `1.0.1`) in a separate directory.

## Running a private registry

The `craft add` command works with any static file server that serves the same directory structure. The CI scripts in `scripts/` are open source under Apache 2.0 and can be reused in your own pipeline.

```bash
pnpm craft add my-internal-cap --registry https://registry.internal.acme.com --allow-unofficial
```

## License

Apache-2.0
