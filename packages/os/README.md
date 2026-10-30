# @routecraft/os

System-native host capabilities for Routecraft: drive the host machine from route pipelines. This is the home for capabilities that are neither standard protocols nor vendor products, things that touch the host, carry heavy or native peers, and have a security surface.

## Available now

- `shell()` -- run a command, isolated by default. It never invokes a shell: the program is spawned directly with an argument vector, so an argument can never become a command. The `unshare` tier denies network egress, hides host processes, and withholds the caller's privileges; it does not contain filesystem reads, which its documentation says in as many words. The `docker` tier runs the command in a throwaway container on a Docker Engine daemon and is the one that contains the filesystem: only the image and the declared mounts are visible. The environment is granted rather than inherited.

## Planned

- Host primitives such as clipboard, notifications, filesystem-watch, and process management.

A separate `sandbox()` factory is deferred: isolation ships as an option on `shell()`, because "run a command, isolated" is one concept and a second factory selecting the same behaviour would be a `mode:` option under another name.

See [`.standards/package-boundaries.md`](https://github.com/routecraftjs/routecraft/blob/main/.standards/package-boundaries.md) for why these live together and the secure-by-default contract.

## Installation

```bash
# shell(): the unshare tier needs no peer beyond these two
bun add @routecraft/os execa shescape
# shell(): the docker tier additionally needs the Docker Engine client
bun add dockerode
```

`npm install`, `pnpm add` and `yarn add` work the same way. `execa`, `shescape` and `dockerode` are optional peers, loaded lazily by the tier that needs them; a missing one fails at runtime with `RC5017` naming the package to install.

## `shell(command, args?, options?)`

Runs a program with an argument vector and returns its output. It is an `Enricher`: `.enrich()` merges the result into the body, `.to()` replaces the body with it, `.tap()` discards it. It never invokes a shell, so an argument can never become a command. The one thing it cannot rule out on its own is an argument that the program reads as one of its own options, which is what `untrusted()` is for.

```typescript
import { craft, direct } from '@routecraft/routecraft';
import { shell, untrusted } from '@routecraft/os';
import { z } from 'zod';

export default craft()
  .id('clone')
  .input({ body: z.object({ url: z.string().url() }) })
  .from(direct())
  .enrich(shell('git', (ex) => ['clone', untrusted(ex.body.url), '/work'], {
    network: true,
    timeout: '60s',
  }));
```

`untrusted(value)` marks a value that came from outside the route's own code. A marked value that starts with a dash is refused before the program runs, so `--upload-pack=...` cannot pose as an option. Marking is per value rather than blanket, because the author's own flags (`--oneline`) must survive. The `require-untrusted-shell-args` rule in `@routecraft/eslint-plugin-routecraft` warns when an exchange-derived value reaches `shell()` unmarked.

### Options

| Option | Type | Description |
|--------|------|-------------|
| `isolation` | `'unshare' \| 'docker' \| 'none'` | Isolation tier. Defaults to `unshare` (Linux only). A tier that cannot be established fails with `OS1001`; it never downgrades silently. `none` runs without isolation, deliberately, and must say `network: true` beside it |
| `network` | `boolean` | Allow network egress. Default `false` |
| `mapRootUser` | `boolean` | Map the caller to root inside the tier's user namespace instead of to itself. Default `false` |
| `cwd` | `string \| (ex) => string` | Working directory |
| `env` | `Record<string, string> \| (ex) => ...` | Environment granted to the command. Nothing is inherited from the host by default |
| `passEnv` | `string[]` | Host variables to pass through by name |
| `stdin` | `string \| Uint8Array \| (ex) => ...` | Data written to the program's stdin |
| `timeout` | `Duration` | `'30s'` or a number of milliseconds; expiry fails with `OS1003` |
| `image`, `mounts`, `name` | | `docker` tier only: the image to run (required there), the host paths to mount, and the container name |
| `failOnNonZero` | `boolean` | Fail the exchange with `OS1002` on a non-zero exit. Default `true` |
| `maxOutputBytes` | `number` | Cap on captured output per stream, 8 MiB by default; overflow keeps the head and the tail and sets `truncated` |

`shellPlugin({ ... })` sets context-wide defaults for these. A per-call value beats the `ROUTECRAFT_SHELL_ISOLATION` operator override, which beats the plugin default, so an operator can harden a deployment from the environment but never weaken what a route demanded.

### Result shape

```typescript
interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;     // set when the program was killed by a signal
  truncated: boolean;  // output hit maxOutputBytes
}
```

### Error codes

`OS1001` isolation tier unavailable, `OS1002` command execution failed, `OS1003` command timed out, `OS1004` isolation cannot satisfy the request. See the [shell reference](https://routecraft.dev/docs/reference/adapters/shell) for what each tier does and does not contain.

## License

Apache-2.0

## Links

- [Documentation](https://routecraft.dev)
- [GitHub Repository](https://github.com/routecraftjs/routecraft)
- [Issue Tracker](https://github.com/routecraftjs/routecraft/issues)
