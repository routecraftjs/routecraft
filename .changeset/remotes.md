---
"@routecraft/routecraft": minor
"@routecraft/cli": minor
"@routecraft/ai": minor
---

`remotes`: the dispatchable routes of another instance become direct endpoints here (#763).

A local instance names other running instances in `craft.config.ts`, and every dispatchable route they expose through the ops management API is a direct endpoint on the local one. `direct()`, `forward()`, `directTool()`, `Direct(...)` in an agent's tool list, the tool policy, the local `/ops/routes` listing, `craft ops routes` and `craft exec` all see them as routes, with nothing to learn.

```ts
export default defineConfig({
  remotes: {
    default: { url: 'https://routecraft.example.internal', auth: { token: () => process.env.RC_REMOTE_TOKEN } },
    lab: { url: 'https://lab.example.internal', auth: { token: () => process.env.RC_LAB_TOKEN } },
  },
})

// .enrich(direct('hello'))       the default remote's route, advertised bare
// .enrich(direct('lab:hello'))   any other remote is qualified
// tools(['Direct(hello)', 'Direct(lab:hello)', 'Remote(lab)'])
```

**Git-style names.** The routes of `default` are advertised bare; every other remote's routes are qualified `name:id`, and `default:id` names the default remote explicitly. Two remotes never collide. A local route with the same id as a default-remote route shadows it: the local one answers, the remote stays reachable as `default:id`, and the shadow is logged as a warning on every refresh that finds it and on every call that resolves to the local route. That overlap is the promotion window, never an error.

**Credentials are the environment's.** `auth.token` is a string or a function evaluated per request, so a rotated token is picked up without a restart. The identity the remote sees is whatever its own validator mints from the token; this feature makes no call on api keys versus JWTs. A bearer over plain `http:` is refused at configuration unless the address is loopback, the rule the CLI already enforces.

**Inventory and schemas are the framework's.** `GET /ops/routes?dispatchable=true` and `GET /ops/routes/{id}` at start, on an interval (`refresh`, default `60s`), and forced by a dispatch that meets a 404 for a route the inventory still lists. A remote unreachable at boot registers nothing, logs, and reports its `remote.<name>` health indicator down; its routes appear on the refresh that first reaches it.

**Outcomes map onto the in-process ones.** Completed is the body; dropped is `RC5031`; suspended is the standard `Suspended` acknowledgment, with resume at the remote's door under its policy; a remote 500 is `RC5064` carrying the remote's code; a 401 or 403 from the door is `RC5063`; an unreachable remote or a timeout is `RC5062`.

**The listing names the origin.** An imported route shows in the local `/ops/routes` as dispatchable with `sources: ["remote"]` and a `remote` field. The agent tool policy's `direct` rule sees `source.remote`, so a policy can keep an agent local-only. Re-exposure through the local door is intentional: a local instance with an open dispatch tier re-exports every imported route under its own door, exactly as a tool fronting an authenticated REST call does.

**Agent tools.** `Direct(hello)` keeps its `direct__hello` wire name; `Direct(lab:hello)` and every expansion of `Remote(lab)` become `remote__lab__hello`, one separator per part, because a colon is outside the provider charset. A remote's name is constrained at configuration the way an MCP client's is.

**The ops client lives in core.** `createOpsHttpClient` is exported from `@routecraft/routecraft` and `packages/cli` imports it; `craft exec`, `craft ops` and the refusal-hint behaviour are unchanged. A plugin can also contribute a health indicator without the app listing it (`contributeOpsIndicator`), which is how a remote reports.
