import type { CraftContext } from "../context.ts";
import { expireSuspension } from "./revive.ts";
import type { ExpiredScanCursor, SuspensionStore } from "./types.ts";

/** How often the sweeper looks for overdue suspensions, when unconfigured. */
export const DEFAULT_SWEEP_INTERVAL = "60s";

/**
 * How long an `expiring` delivery claim is honoured before it is released
 * back to `suspended` for redelivery.
 *
 * Deliberately generous relative to handler work: a lease shorter than a
 * slow error handler would make one healthy process double-deliver by
 * itself. The lease only matters after a crash, so its length costs nothing
 * in the healthy case.
 */
export const DEFAULT_EXPIRY_LEASE = "60m";

/**
 * How long settled suspensions are kept before the sweeper purges them,
 * when unconfigured. `"never"` opts out for audit deployments.
 */
export const DEFAULT_SUSPENSION_RETENTION = "90d";

/**
 * How long a suspension stays resumable when `.suspend()` names no `ttl`.
 *
 * Three days. Long enough to survive a weekend, so an approver who is away
 * on Friday still has a live link on Monday, and short enough that an
 * unanswered approval does not sit in the store forever. Configurable per
 * context, and overridable per suspend.
 */
export const DEFAULT_SUSPENSION_TTL = "72h";

/**
 * Suspensions retired per `findExpired` call.
 *
 * The scan pages rather than loading the overdue set in one query, because
 * the backlog after a long outage is unbounded and each retirement runs a
 * route's error handler. Paging keeps memory flat and lets the startup scan
 * report progress instead of appearing hung.
 */
const SWEEP_BATCH = 100;

/**
 * Stranded resumes fetched for the boot summary.
 *
 * Bounded because this is a report, not a work queue: past a certain point
 * the count is the signal and the ids stop being individually actionable.
 */
const STRANDED_REPORT = 100;

/**
 * Distinct absent routes named per orphan warning. Same bounding logic as
 * {@link STRANDED_REPORT}: past this the count is the signal.
 */
const MISSING_ROUTE_REPORT = 20;

/** How often a sweep pass also purges settled records past retention. */
const PURGE_CADENCE_MS = 60 * 60 * 1000;

/**
 * Drives expiry for one context.
 *
 * Expiry has to be pushed rather than pulled. A `ttl` exists so a route can
 * react when nobody answers, and by definition nobody is going to present a
 * token for a suspension that timed out, so without something firing on a
 * schedule the "escalate after 72 hours" flow never runs at all.
 *
 * The sweeper never decides an outcome by itself: it competes for the same
 * compare-and-swap a late answer competes for, so a suspension resumed at
 * the instant it expires has exactly one winner, and only that winner
 * notifies.
 *
 * @internal
 */
export interface SweeperOptions {
  readonly intervalMs: number;
  readonly leaseMs: number;
  /** Absent when the context opted out with `retention: "never"`. */
  readonly retentionMs?: number;
}

export class SuspensionSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The sweep currently running. See {@link SuspensionSweeper.stop}. */
  private inFlight: Promise<unknown> | undefined;
  /**
   * Set the moment shutdown begins, which is earlier than teardown: routes
   * are aborted and drained before plugins are torn down, so a tick landing
   * in that window would retire into a route that can no longer notify.
   */
  private stopping = false;
  private offStopping: (() => void) | undefined;
  /** Epoch ms of the last retention purge; zero forces one on the boot scan. */
  private lastPurgeAt = 0;

  constructor(
    private readonly context: CraftContext,
    private readonly store: SuspensionStore,
    private readonly options: SweeperOptions,
  ) {}

  /**
   * Retire every suspension already overdue at `now`.
   *
   * Returns how many this pass retired, which is what makes the startup
   * scan able to say whether a restart had work waiting for it.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    // Heal before scanning: a claim whose holder died mid-delivery flips
    // back to `suspended` once its lease elapses, and the released records
    // are past their deadline, so this same pass redelivers them.
    const released = await this.store.releaseExpiring(
      new Date(now.getTime() - this.options.leaseMs),
    );
    if (released > 0) {
      this.context.logger.info(
        { released },
        "Released stale expiry claims for redelivery; a process died while delivering them.",
      );
    }

    await this.purgeOnCadence(now);

    let retired = 0;
    let visited = 0;
    const missing = new Map<string, number>();
    // Keyset pages: the cursor advances strictly past every record visited,
    // retired or not, so an arbitrarily long unretirable prefix can never
    // starve the records behind it. `now` is frozen at pass start, which is
    // what bounds a pass while records keep coming due.
    let cursor: ExpiredScanCursor | undefined;
    for (;;) {
      if (this.stopping) break;
      const due = await this.store.findExpired(now, SWEEP_BATCH, cursor);
      if (due.length === 0) break;

      for (const suspension of due) {
        // Between retirements, not only between pages: shutdown can begin
        // mid-batch, and a claim taken after that point notifies nobody.
        if (this.stopping) break;
        const deadline = suspension.expiresAt;
        if (deadline === undefined) {
          // Contractually unreachable: findExpired only returns records with
          // a deadline. A backend that violates that cannot advance the
          // cursor, so the pass aborts rather than re-reading the same page.
          this.context.logger.error(
            { suspensionId: suspension.id },
            "findExpired returned a suspension without a deadline; aborting this sweep pass.",
          );
          return retired;
        }
        cursor = { expiresAt: deadline, id: suspension.id };
        visited++;
        const route = this.context.getRouteById(suspension.routeId);
        if (!route) {
          // The store outlives any one deployment, so it can hold work for
          // a route this process does not have. Retiring it here would
          // consume the record with nobody able to run its error channel,
          // so it is left for the deployment that owns it. Counted rather
          // than logged per record: an orphaned route means one problem,
          // not one problem per parked exchange.
          missing.set(
            suspension.routeId,
            (missing.get(suspension.routeId) ?? 0) + 1,
          );
          continue;
        }
        try {
          const { cas } = await expireSuspension(
            this.context,
            this.store,
            route,
            { ...suspension, expiresAt: deadline },
          );
          if (cas.won) retired++;
        } catch (err) {
          // One route's error handler throwing must not strand the rest of
          // the batch: the sweep is the only thing that will ever visit
          // them.
          this.context.logger.error(
            { err, suspensionId: suspension.id, routeId: suspension.routeId },
            "Failed to retire an expired suspension; continuing the sweep.",
          );
        }
      }

      if (due.length < SWEEP_BATCH) break;
      this.context.logger.info(
        { retired },
        "Still retiring expired suspensions",
      );
    }

    this.reportMissingRoutes(missing);
    if (visited > 0 && retired === 0 && !this.stopping) {
      this.context.logger.warn(
        { visited },
        "Overdue suspensions were visited but none could be retired this pass. Each stays parked and is revisited next sweep; the route warnings above say why.",
      );
    }
    return retired;
  }

  /**
   * Purge settled records past retention, at most once per
   * {@link PURGE_CADENCE_MS} and once on the boot scan. The store deletes
   * in one statement; there is nothing to page or notify.
   */
  private async purgeOnCadence(now: Date): Promise<void> {
    const retentionMs = this.options.retentionMs;
    if (retentionMs === undefined) return;
    if (now.getTime() - this.lastPurgeAt < PURGE_CADENCE_MS) return;
    this.lastPurgeAt = now.getTime();
    try {
      const purged = await this.store.purgeSettled(
        new Date(now.getTime() - retentionMs),
      );
      if (purged > 0) {
        this.context.logger.info(
          { purged },
          "Purged settled suspensions past retention.",
        );
      }
    } catch (err) {
      this.context.logger.error(
        { err },
        "Failed to purge settled suspensions; the next cadence will retry.",
      );
    }
  }

  /** One bounded warning per absent route, never one per record. */
  private reportMissingRoutes(missing: Map<string, number>): void {
    let reported = 0;
    let overflowRoutes = 0;
    let overflowRecords = 0;
    for (const [routeId, count] of missing) {
      if (reported >= MISSING_ROUTE_REPORT) {
        overflowRoutes++;
        overflowRecords += count;
        continue;
      }
      reported++;
      this.context.logger.warn(
        { routeId, count },
        `${count} expired suspension(s) belong to route "${routeId}", which this context does not have, so they were left for a context that does. Either that route was renamed or removed while suspensions for it were still parked, or two deployments are sharing one suspension store and should not be.`,
      );
    }
    if (overflowRoutes > 0) {
      this.context.logger.warn(
        { routes: overflowRoutes, records: overflowRecords },
        "Further absent routes hold expired suspensions this context left alone.",
      );
    }
  }

  /**
   * Sweep what expired while the process was down, and report what is
   * parked.
   *
   * Awaited by `start()` on purpose, so a context is not ready until its
   * overdue work has reached the routes that own it. An operator restarting
   * after an outage gets the escalations before the new traffic, which is
   * the order they would have arrived in had the process stayed up.
   */
  async scanOnStart(): Promise<void> {
    // Held in the same slot the interval uses, so a shutdown arriving during
    // the scan waits for it rather than closing the store underneath it.
    this.inFlight = this.runStartScan().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  /** @internal */
  private async runStartScan(): Promise<void> {
    const retired = await this.sweep();
    const summary = await this.store.pending();
    const stranded = await this.store.resumedWithoutTerminal(STRANDED_REPORT);

    this.context.logger.info(
      {
        retiredOnStart: retired,
        pending: summary.count,
        ...(summary.oldest !== undefined
          ? { oldestSuspendedAt: summary.oldest.toISOString() }
          : {}),
        stranded: stranded.length,
        ...(stranded[0] !== undefined
          ? { oldestStrandedAt: stranded[0].suspendedAt.toISOString() }
          : {}),
      },
      "Suspension store scanned",
    );

    if (stranded.length > 0) {
      // Reported, never re-driven. Each of these spent its approval and may
      // have half applied its side effects, so an operator decides what
      // happens to it. Ids at debug because the count is what an alert
      // watches and the ids are what an investigation needs.
      this.context.logger.warn(
        { stranded: stranded.length },
        "Suspensions were resumed but never recorded an outcome, so a process died mid-continuation. Their approvals are spent and nothing will retry them; each needs an operator.",
      );
      this.context.logger.debug(
        { suspensionIds: stranded.map((record) => record.id) },
        "Stranded suspension ids",
      );
    }
  }

  /** Begin the periodic sweep. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.offStopping = this.context.on("context:stopping", () => {
      void this.stop();
    });
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.sweep()
        .catch((err: unknown) => {
          this.context.logger.error(
            { err },
            "Suspension sweep failed; the next tick will retry.",
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.options.intervalMs);
    // A sweep must never be the reason a process stays alive: it exists to
    // serve routes, and a context whose routes have all finished should
    // exit.
    this.timer.unref?.();
  }

  /**
   * Stop the periodic sweep and wait for the one in flight. Idempotent.
   *
   * Awaiting matters more than clearing the interval: the caller closes the
   * store next, and a sweep still running would meet a closed handle. Worse,
   * a retirement that already won its transition would re-enter a route that
   * has drained, leaving the record `expired` with its approver never told
   * and nothing left to revisit it.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.offStopping?.();
    this.offStopping = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}
