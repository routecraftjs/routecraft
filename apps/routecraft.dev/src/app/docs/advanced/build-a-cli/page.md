---
title: Build a CLI
---

Turn your capabilities into a typed CLI tool with flags, help text, and schema validation. {% .lead %}

## How it works

The `cli()` adapter turns routecraft routes into CLI commands. Each `cli()` source defines one command; its schema properties become named flags. When all routes in a file use `cli()` sources, `craft run` enters CLI mode and dispatches to the right command based on argv.

For standalone packaging, the `cliRunner()` helper lets you bypass `craft run` entirely and ship your file as a named binary.

## Install

```bash
npm install @routecraft/routecraft @routecraft/tools @routecraft/cli zod
```

Any [Standard Schema](https://standardschema.dev)-compliant library works in place of Zod (Valibot, ArkType, etc.).

## Define commands

Each `cli()` call registers one command. Pass a schema to define flags and a description for help text.

```ts
// mycli.ts
import { craft } from '@routecraft/routecraft';
import { cli } from '@routecraft/tools';
import { z } from 'zod';

export default [
  craft()
    .id('greet')
    .from(cli('greet', {
      schema: z.object({
        name: z.string().describe('Name to greet'),
        loud: z.boolean().optional().describe('Use uppercase'),
      }),
      description: 'Greet someone',
    }))
    .transform(({ name, loud }) =>
      loud ? `HELLO ${name.toUpperCase()}!` : `Hello, ${name}!`
    )
    .to(cli.stdout()),

  craft()
    .id('version')
    .from(cli('version', { description: 'Print the version' }))
    .transform(() => '1.0.0')
    .to(cli.stdout()),
];
```

## Run with craft run

During development, use `craft run` to invoke your CLI:

```bash
# Show help listing all commands
craft run mycli.ts

# Run a command
craft run mycli.ts greet --name Alice

# Per-command help
craft run mycli.ts greet --help
```

## Package as a standalone binary

Use `cliRunner()` to run routes directly without `craft run`. Import it from `@routecraft/cli/runner` to avoid triggering the CLI argument parser.

```ts
#!/usr/bin/env tsx
// mycli.ts
import { craft } from '@routecraft/routecraft';
import { cli } from '@routecraft/tools';
import { cliRunner } from '@routecraft/cli/runner';
import { z } from 'zod';

const routes = [
  craft()
    .id('greet')
    .from(cli('greet', {
      schema: z.object({ name: z.string() }),
      description: 'Say hello',
    }))
    .transform(({ name }) => `Hello, ${name}!`)
    .to(cli.stdout()),
];

export default routes;
await cliRunner(routes, { name: 'myclid' });
```

Add a `bin` entry to your `package.json`:

```json
{
  "bin": {
    "myclid": "./src/mycli.ts"
  }
}
```

After `npm link` or publishing:

```bash
myclid greet --name World    # Hello, World!
myclid                        # shows help
myclid greet --help           # per-command help
```

### cliRunner options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | `basename(process.argv[1])` | Binary name used in help text |
| `argv` | `string[]` | `process.argv.slice(2)` | CLI arguments to parse |

## Flag types and coercion

The flag parser uses JSON Schema type hints from your schema to coerce values:

| Schema type | Input | Result |
|-------------|-------|--------|
| `string` | `--name Alice` | `"Alice"` |
| `number` / `integer` | `--count 42` | `42` |
| `boolean` | `--verbose` | `true` |
| `boolean` (negated) | `--no-verbose` | `false` |

Flags are always written in kebab-case on the command line (`--dry-run`) and converted to camelCase keys (`dryRun`) before validation.

## Schema validation

Flags are validated through Standard Schema before reaching the handler. If validation fails, a `RC5002` error is thrown with the issue details.

```ts
// Required flag -- omitting --name produces RC5002
z.object({ name: z.string() })

// Optional with default -- --loud is optional, defaults to false
z.object({
  name: z.string(),
  loud: z.boolean().default(false),
})
```

Schemas must describe flat objects. Nested objects are not converted to flags.

## Output

Use `cli.stdout()` and `cli.stderr()` as destinations:

- **Strings** are written as-is with a trailing newline
- **Objects and arrays** are pretty-printed as JSON (2-space indent)
- **Other values** are converted via `String()`

```ts
// Write to stdout (default)
.to(cli.stdout())

// Write errors to stderr
.to(cli.stderr())
```

## Help text

Help is auto-generated from command metadata:

- **Global help** (no command): lists all commands with descriptions
- **Per-command help** (`<command> --help`): shows flags with types, required markers, defaults, and descriptions

Flag descriptions come from the schema's `.describe()` calls (Zod) or equivalent in your schema library.

## One file per CLI

All routes in a CLI-mode file must use `cli()` sources. Mixing `cli()` with other adapters (`http`, `mcp`, `direct`, etc.) in the same file produces an error. Move non-CLI routes to a separate file.

---

## Related

{% quick-links %}

{% quick-link title="CLI adapter reference" icon="presets" href="/docs/reference/adapters#cli" description="Full cli() adapter API, signatures, and options." /%}
{% quick-link title="CLI reference" icon="installation" href="/docs/reference/cli" description="craft run command and global options." /%}
{% quick-link title="Expose as MCP" icon="plugins" href="/docs/advanced/expose-as-mcp" description="Expose capabilities as MCP tools for AI clients." /%}

{% /quick-links %}
