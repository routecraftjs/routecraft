import type { HealthLedger } from "./state";
import { rcError } from "../../error";
import { port } from "../../kernel/port.ts";
import type { PortLookup } from "../../kernel/port.ts";
import type { Duration } from "../../shared/duration.ts";
import type { RemoteRoute } from "../remotes/store";
import { assertIndicatorName } from "./indicator";
import type { FailureDomain, Health, OpsResource } from "./types";

/**
 * An indicator another plugin contributes, without the app listing it.
 *
 * `defineIndicator` is the app's API: a handle declared in source and named
 * in `ops.indicators`. A plugin that watches a dependency the app never
 * wrote a line for (the remotes plugin and the instances it imports from)
 * has no such handle to hand the app, so it contributes the declaration
 * through {@link OPS} and reports through the function the contribution
 * returns. The ops plugin binds it to its ledger at start, and before that
 * a report is kept for replay, because health instrumentation must not be
 * able to fail the code it instruments.
 */
export interface ContributedIndicator {
  readonly name: string;
  readonly domain?: FailureDomain;
  readonly maxAge?: Duration;
  /**
   * Where reports go: the ledger's sink once the ops plugin bound the
   * indicator. Empty before that, and empty again after teardown.
   */
  readonly sinks: Set<(health: Health, reportedAt: number) => void>;
  /**
   * The most recent report, replayed to a ledger that binds after it was
   * made. A contributor whose start() ran before the ops plugin's would
   * otherwise have its first verdict lost, and a remote unreachable at boot
   * would read as up until its next refresh.
   */
  last?: { health: Health; at: number };
}

/** What a plugin declares when it contributes an indicator. */
export type IndicatorContribution = Omit<
  ContributedIndicator,
  "sinks" | "last"
>;

/**
 * The operational surface, as other plugins reach it: the health ledger to
 * read, and the seams to contribute management resources, indicators and
 * routes imported from elsewhere. Provided by the ops plugin.
 *
 * A contributor declares `optional: [OPS]`, which orders the ops plugin
 * ahead of it, and contributes from its own `bind`.
 */
export interface OpsService {
  /**
   * The live health ledger, for surfaces that read health without going
   * through HTTP: a TUI, a console, the `/ops` endpoints themselves.
   */
  readonly health: HealthLedger;
  /**
   * Contribute a read-only resource to the management API. See
   * {@link OpsResource} for the contract and where it is served.
   *
   * @throws RC5053 on a reserved or malformed name, or a name already taken
   */
  registerResource<TItem>(resource: OpsResource<TItem>): void;
  /** Whether a resource by this name is already contributed. */
  hasResource(name: string): boolean;
  /**
   * Contribute an indicator to the health report.
   *
   * @returns The function to report through. A report made before the ops
   *   plugin binds the indicator is kept and replayed into the ledger when
   *   it binds, at the time it was made.
   * @throws RC5053 on a malformed name, or a name another contributor took
   */
  contributeIndicator(
    definition: IndicatorContribution,
  ): (health: Health) => void;
  /**
   * Contribute routes imported from other instances, read per request so
   * the listing follows every refresh. Listed, described and dispatched
   * through the local door beside the local routes.
   */
  contributeRemoteRoutes(routes: () => ReadonlyMap<string, RemoteRoute>): void;
}

/** The operational surface of an application. */
export const OPS = port<OpsService>("routecraft.ops@1");

/** Names the mount serves itself; a contributed resource cannot take them. */
const RESERVED_RESOURCE_NAMES = new Set(["routes", "events"]);

/** A resource name is one path segment: what an operator types after `/ops/`. */
const RESOURCE_NAME = /^[a-z][a-z0-9-]*$/;

function assertResourceName(name: unknown): void {
  if (typeof name !== "string" || !RESOURCE_NAME.test(name)) {
    throw rcError("RC5053", undefined, {
      message: `Management resource name "${String(name)}" must be one lowercase path segment (letters, digits and dashes), because it is what follows /ops/ on the wire.`,
    });
  }
  if (RESERVED_RESOURCE_NAMES.has(name)) {
    throw rcError("RC5053", undefined, {
      message: `Management resource name "${name}" is served by the ops mount itself and cannot be contributed.`,
    });
  }
}

/**
 * The contributions one ops plugin collects for one application.
 *
 * @internal Built by the ops plugin and provided as {@link OPS}.
 */
export class OpsContributions implements OpsService {
  readonly resources = new Map<string, OpsResource>();
  readonly indicators = new Map<string, ContributedIndicator>();
  private readonly remoteSources: Array<
    () => ReadonlyMap<string, RemoteRoute>
  > = [];

  constructor(readonly health: HealthLedger) {}

  registerResource<TItem>(resource: OpsResource<TItem>): void {
    assertResourceName(resource.name);
    if (this.resources.has(resource.name)) {
      throw rcError("RC5053", undefined, {
        message: `Management resource "${resource.name}" is already registered on this context. One contributor per name.`,
      });
    }
    this.resources.set(resource.name, resource as OpsResource);
  }

  hasResource(name: string): boolean {
    return this.resources.has(name);
  }

  contributeIndicator(
    definition: IndicatorContribution,
  ): (health: Health) => void {
    assertIndicatorName(definition.name, "contributeOpsIndicator");
    if (this.indicators.has(definition.name)) {
      throw rcError("RC5053", undefined, {
        message: `Indicator "${definition.name}" is already contributed on this context. One contributor per name.`,
      });
    }
    const entry: ContributedIndicator = { ...definition, sinks: new Set() };
    this.indicators.set(definition.name, entry);
    return (health) => {
      const at = Date.now();
      entry.last = { health, at };
      for (const sink of entry.sinks) sink(health, at);
    };
  }

  contributeRemoteRoutes(routes: () => ReadonlyMap<string, RemoteRoute>): void {
    this.remoteSources.push(routes);
  }

  /** Every contributed imported route, by local endpoint. */
  remoteRoutes(): ReadonlyMap<string, RemoteRoute> {
    if (this.remoteSources.length === 1) return this.remoteSources[0]!();
    const merged = new Map<string, RemoteRoute>();
    for (const source of this.remoteSources) {
      for (const [endpoint, route] of source()) merged.set(endpoint, route);
    }
    return merged;
  }
}

/**
 * Contribute a read-only resource to the management API from a plugin's
 * `bind`. Inert in an application with no ops plugin; the plugin must
 * declare `optional: [OPS]` either way.
 *
 * @param c - The contributing plugin's context
 * @param resource - The resource
 * @throws RC5053 on a reserved or malformed name, or a name already taken
 */
export function registerOpsResource<TItem>(
  c: PortLookup,
  resource: OpsResource<TItem>,
): void {
  assertResourceName(resource.name);
  c.lookup(OPS)?.registerResource(resource);
}

/**
 * Contribute an indicator to the health report from a plugin's `bind`.
 *
 * Returns the function to report through. In an application with no ops
 * plugin a report goes nowhere; the plugin must declare `optional: [OPS]`
 * either way.
 *
 * @param c - The contributing plugin's context
 * @param definition - The indicator
 * @throws RC5053 on a malformed name, or a name another contributor took
 */
export function contributeOpsIndicator(
  c: PortLookup,
  definition: IndicatorContribution,
): (health: Health) => void {
  assertIndicatorName(definition.name, "contributeOpsIndicator");
  return c.lookup(OPS)?.contributeIndicator(definition) ?? (() => undefined);
}
