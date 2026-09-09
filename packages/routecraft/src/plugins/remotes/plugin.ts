/**
 * Remotes plugin: the dispatchable routes of other instances become direct
 * endpoints here.
 *
 * The consumer is a deployment where one constrained instance hosts
 * approved capabilities behind its own door and every engineer runs a
 * local instance with their own agents. The local instance names the
 * server under `remotes`, reads its route inventory through the ops
 * management API, and registers each route in the direct store and the
 * capability registry under a local endpoint. From then on nothing else
 * in the framework knows the route is elsewhere: `direct()`, `forward()`,
 * `directTool()`, `Direct(...)` in an agent's tool list, the tool policy
 * and the local ops listing all see a capability.
 *
 * The server keeps its service credentials and its `.authorize()`; this
 * side holds only a bearer for the server's door, and the local caller's
 * principal is never forwarded. What the server's validator mints from the
 * bearer is the identity every imported route runs under.
 */

import type { CraftContext, CraftPlugin } from "../../context";
import { rcError } from "../../error";
import {
  CAPABILITY_REGISTRY,
  isInternalEndpoint,
  registerCapability,
  type Capability,
} from "../../capabilities";
import {
  ADAPTER_DIRECT_STORE,
  sanitizeEndpoint,
} from "../../adapters/direct/shared";
import type { DirectChannel } from "../../adapters/direct/types";
import type { Exchange } from "../../exchange";
import { parseDuration } from "../../shared/duration.ts";
import {
  createOpsHttpClient,
  isLoopbackHostname,
  type OpsHttpClient,
} from "../ops/client";
import { contributeOpsIndicator } from "../ops/store";
import type { Health, OpsRouteDetail } from "../ops/types";
import { RemoteDirectChannel, type RemoteTarget } from "./channel";
import { standardSchemaFromJsonSchema } from "./schema";
import { REMOTE_ROUTES, type RemoteRoute } from "./store";
import type { RemoteDefinition, RemotesPluginOptions } from "./types";

/** The remote whose routes are advertised bare. */
const DEFAULT_REMOTE = "default";

const DEFAULT_REFRESH = "60s";
const DEFAULT_TIMEOUT = "30s";

/**
 * A remote's name is one segment of a tool wire name (`remote__lab__hello`)
 * and one half of a qualified endpoint (`lab:hello`), so it carries the
 * charset a model provider accepts and never the `__` separator that
 * would make the wire name ambiguous to split.
 */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** One remote's live state on one context. */
interface RemoteRuntime {
  name: string;
  definition: RemoteDefinition;
  client: OpsHttpClient;
  report: (health: Health) => void;
  refreshMs: number | undefined;
  /** The channels this remote installed, by local endpoint. */
  channels: Map<string, RemoteDirectChannel>;
  /** The last inventory's detail per local endpoint, shadowed ones included. */
  details: Map<string, OpsRouteDetail>;
  timer?: ReturnType<typeof setInterval>;
  inflight?: Promise<void>;
  /** Whether the last refresh failed, so a repeat is logged quietly. */
  down: boolean;
  /** Whether an inventory has ever landed, so the first one is logged at info. */
  seen: boolean;
}

/** Per-context state. One plugin instance may serve several contexts. */
interface Runtime {
  remotes: RemoteRuntime[];
  /** Stops listening for local routes stopping. */
  off?: () => void;
}

/** The health indicator an imported remote reports through. */
function indicatorName(remote: string): string {
  return `remote.${remote}`;
}

/** The local endpoint a remote route answers on when qualified. */
function qualified(remote: string, id: string): string {
  return `${remote}:${id}`;
}

/**
 * Validate the config key once, at construction, so a typo fails
 * `defineConfig` rather than the first refresh.
 */
function validate(options: RemotesPluginOptions): void {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options)
  ) {
    throw rcError("RC5003", undefined, {
      message: `remotes must be an object of remotes by name, e.g. { default: { url } }.`,
    });
  }
  for (const [name, definition] of Object.entries(options)) {
    if (!REMOTE_NAME.test(name) || name.includes("__") || name.endsWith("_")) {
      throw rcError("RC5003", undefined, {
        message: `remotes.${name}: a remote name must match ${REMOTE_NAME.source}, must not contain "__" and must not end in "_". It becomes one segment of the tool name a model sees (remote__${name}__<route>) and the prefix of every qualified endpoint (${name}:<route>).`,
      });
    }
    if (typeof definition !== "object" || definition === null) {
      throw rcError("RC5003", undefined, {
        message: `remotes.${name} must be an object with at least a url.`,
      });
    }
    let url: URL;
    try {
      url = new URL(definition.url);
    } catch {
      throw rcError("RC5003", undefined, {
        message: `remotes.${name}.url must be an absolute URL; got ${JSON.stringify(definition.url)}.`,
      });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw rcError("RC5003", undefined, {
        message: `remotes.${name}.url must be an http or https URL; got ${url.protocol}.`,
      });
    }
    const token = definition.auth?.token;
    if (
      token !== undefined &&
      typeof token !== "function" &&
      (typeof token !== "string" || token.length === 0)
    ) {
      throw rcError("RC5003", undefined, {
        message: `remotes.${name}.auth.token must be a non-empty string or a function returning one.`,
      });
    }
    // The same rule the CLI enforces, for the same reason: a bearer over
    // plain http is readable by every hop, and loopback is the one address
    // where there are none.
    if (
      token !== undefined &&
      url.protocol === "http:" &&
      !isLoopbackHostname(url.hostname)
    ) {
      throw rcError("RC5003", undefined, {
        message: `remotes.${name}.url is ${definition.url}, which is plain http, and auth.token would travel over it as clear text. Use an https URL, or a loopback address (localhost, 127.0.0.1, ::1) for an instance on this machine.`,
      });
    }
    if (definition.timeout !== undefined) {
      parseDuration(definition.timeout, `remotes.${name}.timeout`);
    }
    if (definition.refresh !== undefined && definition.refresh !== false) {
      parseDuration(definition.refresh, `remotes.${name}.refresh`);
    }
  }
}

/**
 * Another instance's dispatchable routes as direct endpoints here.
 *
 * Materialised by the config applier, so apps normally write
 * `defineConfig({ remotes: { default: { url, auth } } })` rather than
 * pushing it onto `config.plugins`.
 *
 * `apply` validates, builds a client per remote and contributes an
 * indicator per remote to the health report. `start` reads every
 * inventory once, awaited, so a route the remote exposes is a local
 * endpoint by the time the context reports ready, and a remote that is
 * unreachable registers nothing, logs, and reports its indicator down;
 * its routes appear on the refresh that first reaches it. `teardown`
 * clears the timers and removes every endpoint this plugin installed.
 */
export function remotesPlugin(options: RemotesPluginOptions): CraftPlugin {
  validate(options);
  const runtimes = new WeakMap<CraftContext, Runtime>();

  return {
    name: "remotes",

    apply(ctx: CraftContext) {
      const remotes: RemoteRuntime[] = Object.entries(options).map(
        ([name, definition]) => {
          const client = createOpsHttpClient({
            url: definition.url,
            ...(definition.auth?.token !== undefined
              ? { token: definition.auth.token }
              : {}),
            timeout: definition.timeout ?? DEFAULT_TIMEOUT,
            describeAddress: () => `remote "${name}" at ${definition.url}`,
            advice: {
              missingCredential: `Set remotes.${name}.auth.token to a credential the remote's door accepts.`,
              unreachable: `Check remotes.${name}.url and that the instance is running.`,
            },
          });
          const refreshMs =
            definition.refresh === false
              ? undefined
              : parseDuration(
                  definition.refresh ?? DEFAULT_REFRESH,
                  `remotes.${name}.refresh`,
                );
          // Deployment domain: every replica reaches the remote with the same
          // credential over the same network, so one failing means all do,
          // and moving traffic between replicas would not help.
          const report = contributeOpsIndicator(ctx, {
            name: indicatorName(name),
            domain: "deployment",
          });
          return {
            name,
            definition,
            client,
            report,
            refreshMs,
            channels: new Map(),
            details: new Map(),
            down: false,
            seen: false,
          };
        },
      );
      runtimes.set(ctx, { remotes });
      if (!ctx.getStore(REMOTE_ROUTES)) {
        ctx.setStore(REMOTE_ROUTES, new Map<string, RemoteRoute>());
      }
    },

    async start(ctx: CraftContext) {
      const runtime = runtimes.get(ctx);
      if (!runtime) return;
      // A local route that stops hands its endpoint to the remote route it
      // shadowed. The direct source registers the capability at subscribe
      // and nothing removes it at stop, so the transition has to rewrite
      // the provenance as well as the channel, and this is the one place
      // that knows both.
      runtime.off = ctx.on("route:stopped", ({ details }) => {
        for (const remote of runtime.remotes) {
          lift(ctx, remote, details.routeId);
        }
      });
      await Promise.all(runtime.remotes.map((remote) => refresh(ctx, remote)));
      for (const remote of runtime.remotes) {
        if (remote.refreshMs === undefined) continue;
        const timer = setInterval(() => {
          void refresh(ctx, remote);
        }, remote.refreshMs);
        timer.unref?.();
        remote.timer = timer;
      }
    },

    async teardown(ctx: CraftContext) {
      const runtime = runtimes.get(ctx);
      if (!runtime) return;
      runtimes.delete(ctx);
      runtime.off?.();
      for (const remote of runtime.remotes) {
        if (remote.timer !== undefined) clearInterval(remote.timer);
        delete remote.timer;
        // A refresh in flight would otherwise re-install what is removed
        // below on a context that is going away.
        await remote.inflight?.catch(() => undefined);
        for (const endpoint of [...remote.channels.keys()]) {
          release(ctx, remote, endpoint);
        }
      }
    },
  };
}

/**
 * Re-read one remote's inventory and reconcile the local endpoints.
 *
 * Serialised per remote: the interval can fire while a forced refresh is
 * still running, and two reconciliations interleaving would install and
 * release the same endpoints against each other. A caller that finds one
 * in flight joins it, which is also the right answer for a dispatch that
 * met a 404 while the interval was already asking.
 */
function refresh(ctx: CraftContext, remote: RemoteRuntime): Promise<void> {
  if (remote.inflight !== undefined) return remote.inflight;
  remote.inflight = reconcile(ctx, remote).finally(() => {
    delete remote.inflight;
  });
  return remote.inflight;
}

async function reconcile(
  ctx: CraftContext,
  remote: RemoteRuntime,
): Promise<void> {
  const { name, client } = remote;
  let details: OpsRouteDetail[];
  try {
    const summaries = await client.listRoutes({ dispatchable: true });
    details = await Promise.all(
      summaries.map((summary) => client.describeRoute(summary.id)),
    );
  } catch (error: unknown) {
    // The last inventory stays: a remote that blinks must not take every
    // imported endpoint with it, and a dispatch against a route that is
    // truly gone finds out at the door and forces the next refresh.
    const log = remote.down ? ctx.logger.debug : ctx.logger.warn;
    log.call(
      ctx.logger,
      { remote: name, url: remote.definition.url, err: error },
      `Remote "${name}" inventory could not be read; keeping the last inventory (${String(remote.channels.size)} routes)`,
    );
    remote.down = true;
    remote.report({
      status: "down",
      details: { routes: remote.channels.size },
    });
    return;
  }

  const wanted = new Map<string, OpsRouteDetail>();
  for (const detail of details) {
    wanted.set(qualified(name, detail.id), detail);
    if (name === DEFAULT_REMOTE) wanted.set(detail.id, detail);
  }
  for (const endpoint of [...remote.channels.keys()]) {
    if (!wanted.has(endpoint)) release(ctx, remote, endpoint);
  }
  for (const [endpoint, detail] of wanted) {
    install(ctx, remote, endpoint, detail);
  }

  const log = remote.seen ? ctx.logger.debug : ctx.logger.info;
  log.call(
    ctx.logger,
    { remote: name, url: remote.definition.url, routes: details.length },
    `Remote "${name}" inventory read: ${String(details.length)} dispatchable routes`,
  );
  remote.seen = true;
  remote.down = false;
  remote.report({ status: "up", details: { routes: details.length } });
}

/**
 * Register one remote route under one local endpoint, or find out why not.
 *
 * Local wins. A capability the registry holds without a `remote` is a
 * local route, and an endpoint declared internal is one too; either
 * shadows the remote route. The remote's channel is still installed
 * around the local one so every call through the shadow says so, and the
 * route stays reachable under its qualified name, which this function is
 * also called for.
 */
function install(
  ctx: CraftContext,
  remote: RemoteRuntime,
  endpoint: string,
  detail: OpsRouteDetail,
): void {
  const { name } = remote;
  const registry = ctx.getStore(CAPABILITY_REGISTRY);
  const existing = registry?.get(endpoint);
  const routes = ctx.getStore(REMOTE_ROUTES)!;
  remote.details.set(endpoint, detail);

  if (
    isInternalEndpoint(ctx, endpoint) ||
    (existing !== undefined && existing.remote === undefined)
  ) {
    ctx.logger.warn(
      { endpoint, remote: name, remoteRouteId: detail.id },
      endpoint === qualified(name, detail.id)
        ? `Local route "${endpoint}" shadows route "${detail.id}" of remote "${name}", which is unreachable until the local route is renamed`
        : `Local route "${endpoint}" shadows route "${detail.id}" of remote "${name}"; the local route answers direct("${endpoint}") and the remote route stays reachable as "${qualified(name, detail.id)}"`,
    );
    routes.delete(endpoint);
    if (!remote.channels.has(endpoint)) {
      const store = directStore(ctx);
      const key = sanitizeEndpoint(endpoint);
      const local = store.get(key);
      // No channel means an internal route that never subscribed, or a
      // route whose channel comes later; there is nothing to warn through.
      if (local === undefined) return;
      const channel = new RemoteDirectChannel(
        target(ctx, remote, endpoint, detail.id),
        local,
      );
      store.set(key, channel);
      remote.channels.set(endpoint, channel);
    }
    return;
  }

  if (existing !== undefined && existing.remote !== name) {
    ctx.logger.error(
      {
        endpoint,
        remote: name,
        remoteRouteId: detail.id,
        heldBy: existing.remote,
      },
      `Route "${detail.id}" of remote "${name}" would be advertised as "${endpoint}", which remote "${existing.remote}" already holds; skipping it. Rename the route on one of the remotes`,
    );
    return;
  }

  advertise(ctx, remote, endpoint, detail);

  if (!remote.channels.has(endpoint)) {
    const store = directStore(ctx);
    // Whatever the store holds here is a placeholder an enricher created
    // on demand before this inventory landed (a subscribed local route
    // would have registered a capability and returned above), so replacing
    // it is what makes that enricher's next fetch reach the remote.
    const channel = new RemoteDirectChannel(
      target(ctx, remote, endpoint, detail.id),
    );
    store.set(sanitizeEndpoint(endpoint), channel);
    remote.channels.set(endpoint, channel);
  }
}

/** Register the remote route as the capability behind a local endpoint. */
function advertise(
  ctx: CraftContext,
  remote: RemoteRuntime,
  endpoint: string,
  detail: OpsRouteDetail,
): void {
  const { name } = remote;
  const capability: Capability = { endpoint, remote: name };
  if (detail.title !== undefined) capability.title = detail.title;
  if (detail.description !== undefined) {
    capability.description = detail.description;
  }
  if (detail.tags !== undefined && detail.tags.length > 0) {
    capability.tags = [...detail.tags];
  }
  if (detail.input?.body !== undefined) {
    capability.input = {
      body: standardSchemaFromJsonSchema(detail.input.body),
    };
  }
  if (detail.output?.body !== undefined) {
    capability.output = {
      body: standardSchemaFromJsonSchema(detail.output.body),
    };
  }
  registerCapability(ctx, capability);
  const routes = ctx.getStore(REMOTE_ROUTES)!;
  routes.set(endpoint, { remote: name, id: detail.id, endpoint, detail });
}

/**
 * Hand a shadowed endpoint to the remote route once the local route that
 * shadowed it has stopped.
 *
 * A shadow is a channel this remote installed for an endpoint that is not
 * listed as one of its routes. The transition rewrites both halves at
 * once: the channel stops answering from the local route, and the
 * capability registry says the endpoint is the remote's, so the listing
 * and an agent's tool policy see a remote-backed endpoint and never a
 * local one that quietly dispatches elsewhere. An internal endpoint is
 * left alone: the app declared it is not a capability, and a remote route
 * behind it would open the door the declaration closed.
 */
function lift(
  ctx: CraftContext,
  remote: RemoteRuntime,
  endpoint: string,
): void {
  const channel = remote.channels.get(endpoint);
  const detail = remote.details.get(endpoint);
  const routes = ctx.getStore(REMOTE_ROUTES);
  if (
    channel === undefined ||
    detail === undefined ||
    routes?.has(endpoint) === true ||
    isInternalEndpoint(ctx, endpoint)
  ) {
    return;
  }
  channel.local = undefined;
  advertise(ctx, remote, endpoint, detail);
  ctx.logger.info(
    { endpoint, remote: remote.name, remoteRouteId: detail.id },
    `The local route on "${endpoint}" has stopped; the route "${detail.id}" of remote "${remote.name}" answers it from now on`,
  );
}

/** Remove one endpoint this remote installed, restoring a shadowed local channel. */
function release(
  ctx: CraftContext,
  remote: RemoteRuntime,
  endpoint: string,
): void {
  const channel = remote.channels.get(endpoint);
  remote.channels.delete(endpoint);
  remote.details.delete(endpoint);
  const registry = ctx.getStore(CAPABILITY_REGISTRY);
  if (registry?.get(endpoint)?.remote === remote.name) {
    registry.delete(endpoint);
  }
  const routes = ctx.getStore(REMOTE_ROUTES);
  if (routes?.get(endpoint)?.remote === remote.name) routes.delete(endpoint);
  const store = ctx.getStore(ADAPTER_DIRECT_STORE);
  const key = sanitizeEndpoint(endpoint);
  if (
    store === undefined ||
    channel === undefined ||
    store.get(key) !== channel
  ) {
    return;
  }
  if (channel.local !== undefined) {
    store.set(key, channel.local);
  } else {
    store.delete(key);
  }
}

function directStore(ctx: CraftContext): Map<string, DirectChannel<Exchange>> {
  let store = ctx.getStore(ADAPTER_DIRECT_STORE);
  if (!store) {
    store = new Map<string, DirectChannel<Exchange>>();
    ctx.setStore(ADAPTER_DIRECT_STORE, store);
  }
  return store;
}

function target(
  ctx: CraftContext,
  remote: RemoteRuntime,
  endpoint: string,
  id: string,
): RemoteTarget {
  return {
    ctx,
    remote: remote.name,
    id,
    endpoint,
    client: remote.client,
    describe: () => remote.definition.url,
    onMissing: () => refresh(ctx, remote),
  };
}
