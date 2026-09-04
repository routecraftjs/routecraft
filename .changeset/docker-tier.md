---
"@routecraft/os": minor
"@routecraft/cli": minor
---

The `docker` isolation tier for `shell()` (#715, closing #647): a throwaway container per command on a Docker Engine daemon, driven through `dockerode` as an optional peer, the only tier that contains the filesystem. `image` is required with no default and passed as one field, `mounts` declares the host paths exposed (absolute and in normal form, so a `..` from data cannot widen them) and nothing else is visible, `name` defaults to `rc-<routeId>-<exchangeId>` so a run can be found, network is denied unless granted, the command replaces the image's entrypoint rather than composing with it, `HOME` is a private tmpfs inside the container, the container is removed on exit, and no daemon is a loud `OS1001` naming the remedy. A host tier refuses the container options with `OS1004` rather than dropping them.

On every tier, `timeout`, `env` and `stdin` now resolve per exchange. `stdin` is written and closed before the command reads, so a token that must appear in neither `docker inspect` nor the process list has a place to travel. The tier contract becomes a union of a host kind (`wrap`) and a container kind (`execute`), discriminated by `kind`.

`@routecraft/cli` depends on `dockerode` so the bundled runtime can take the tier. The isolation smoke in CI runs the docker tier's guarantees against the runner's daemon.
