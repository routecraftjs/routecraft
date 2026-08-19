---
"@routecraft/routecraft": patch
---

Name the mount topology when a declared server has nothing mounted on it.

`servers.mcp: server has no mounts.` said nothing about what did mount, which
is the fact a reader needs: an empty server usually means the surface meant
for it never mounted, not that the config naming it is wrong. The refusal now
lists every mount and the server it landed on, and reports all empty servers
together rather than one boot at a time:

```
servers.mcp: server has no mounts. Mounted surfaces: http -> servers.public.
Either remove the unused server, or bind a surface to it. A surface that names
the server in config but did not mount is usually a plugin that failed to
apply, a misspelt server name, or a plugin version that predates named servers.
```

The check moved from `HttpMountRegistry.validate()` up to the servers plugin,
which is the only place that can see across servers. A registry validated
directly no longer refuses itself for being empty.
