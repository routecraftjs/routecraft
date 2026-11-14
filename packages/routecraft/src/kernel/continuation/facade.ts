import type { CraftContext } from "../../context.ts";
import { type Exchange, getExchangeContext } from "../../exchange.ts";
import type { Principal } from "../../principal.ts";
import type { ExchangeScoped } from "../../types.ts";
import { authorityOf } from "../authority.ts";
import { deferredPrincipal, reidentificationDeviation } from "./door.ts";
import { stepStateFingerprint } from "./hash.ts";
import { CONTINUATIONS, requireContinuations } from "./port.ts";
import {
  deferralScope,
  type ResumeAcknowledgment,
  type ResumeRequest,
  reviveDeferral,
  type RevivalOptions,
} from "./resume.ts";
import {
  decodeOutcome,
  decodePersistable,
  encodePersistable,
} from "./serialize.ts";
import {
  type Deferral,
  type DeferralCasResult,
  type DeferralListQuery,
  type DeferralSummary,
  resumable,
} from "./types.ts";

/**
 * The application's parked exchanges, to read. Any code holding an exchange
 * gets one from {@link continuationsOf}; it covers every record of the
 * application, because a read is not an act.
 */
export interface ContinuationsView {
  /** Whether a plugin provides continuations. Every read but `verifyToken` is `RC5052` without one. */
  readonly available: boolean;
  /**
   * One record, with `stepState`, `meta` and a settled continuation's body
   * in the form the step handed them over: a `Date` is a `Date`.
   */
  get(id: string): Promise<Deferral | undefined>;
  list(query: DeferralListQuery): Promise<DeferralSummary[]>;
  /**
   * The deferral id a resume token names, or `undefined` for a token this
   * application did not sign. It never says which check failed, and a
   * verified token is not an authorization to resume.
   */
  verifyToken(token: string): string | undefined;
  /** The principal the exchange parked with, restored, never authentic. */
  deferredPrincipal(record: Deferral): Principal | undefined;
  /**
   * Why a principal re-verified from live state is not the one that
   * parked, or `undefined` when it is the same identity.
   */
  reidentificationDeviation(
    parked: Principal | undefined,
    live: Principal,
  ): string | undefined;
  /** The ids an event about this record carries, so it correlates with the kernel's own. */
  eventScope(record: Deferral): ExchangeScoped;
}

/**
 * The view plus the acts. A plugin holds it as `c.continuations`, the
 * application as `context.continuations`. Each act is flagged by the
 * `restrict-continuation-minting` lint rule, so a call site is a decision
 * someone reviewed.
 */
export interface Continuations extends ContinuationsView {
  /**
   * Resume a parked exchange with no ingress door: no door policy and no
   * live principal, unless the caller re-verified the parked identity and
   * hands it over as `options.reidentified`.
   *
   * @throws RC5052 when no plugin provides continuations
   * @throws RC5056 when `reidentified` is restored or is not the parked identity
   */
  resume(
    request: ResumeRequest,
    options?: RevivalOptions,
  ): Promise<ResumeAcknowledgment>;
  /**
   * One pass of the kernel's sweep: heal claims whose deliverer died, purge
   * settled records past retention, retire what is overdue through each
   * route's error channel. A pass already running is joined.
   *
   * @param options.boot - The first pass of an application: it also logs a
   *   summary of the resumes a previous process left stranded, and throws
   *   on a store failure where a later pass logs it. The deferral plugin's
   *   `start` passes it; a pass a plugin drives leaves it out
   * @returns How many parked exchanges this pass retired; zero without a
   *   provider or while the application stops
   */
  sweep(options?: { readonly boot?: boolean }): Promise<number>;
  /**
   * A resume token for a record, for a link sent after the exchange parked.
   *
   * @throws RC5052 when no plugin provides continuations
   */
  mintToken(id: string, options?: { readonly callBinding?: string }): string;
  /**
   * Replace a waiting record's step state. `rewrite` receives the state as
   * the step handed it over and returns the replacement. The swap lands
   * only when nothing resumed, claimed or rewrote the record in between;
   * `won: false` carries the record as it stands.
   *
   * @throws RC5042 when the replacement cannot be stored
   */
  rewriteStepState(
    id: string,
    rewrite: (state: unknown) => unknown | Promise<unknown>,
  ): Promise<DeferralCasResult>;
}

/** A stored record with its free-form slots in live form. */
function live(record: Deferral): Deferral {
  return {
    ...record,
    ...(record.stepState !== undefined
      ? { stepState: decodePersistable(record.stepState, "stepState") }
      : {}),
    ...(record.meta !== undefined
      ? { meta: decodePersistable(record.meta, "meta") }
      : {}),
    ...(record.continuation !== undefined
      ? { continuation: decodeOutcome(record.continuation) }
      : {}),
  };
}

function continuationsView(
  context: CraftContext | undefined,
): ContinuationsView {
  const runtime = (attempted: string) =>
    requireContinuations(context, attempted);
  return Object.freeze({
    get available() {
      return context?.lookup(CONTINUATIONS) !== undefined;
    },
    async get(id: string) {
      const record = await runtime("Reading a deferral").store.get(id);
      return record && live(record);
    },
    list: (query: DeferralListQuery) =>
      runtime("Listing deferrals").store.list(query),
    verifyToken(token: string) {
      try {
        return context?.lookup(CONTINUATIONS)?.signer.verify(token).id;
      } catch {
        return undefined;
      }
    },
    deferredPrincipal: (record: Deferral) =>
      context === undefined
        ? undefined
        : deferredPrincipal(record, authorityOf(context)),
    reidentificationDeviation: (
      parked: Principal | undefined,
      reminted: Principal,
    ) =>
      context === undefined
        ? "was checked outside an application"
        : reidentificationDeviation(parked, reminted, authorityOf(context)),
    eventScope: deferralScope,
  });
}

/**
 * The facade a context hands out. `sweep` is the context's own, because the
 * sweeper is one per application.
 *
 * @internal
 */
export function continuationsFacade(
  context: CraftContext,
  sweep: Continuations["sweep"],
): Continuations {
  const view = continuationsView(context);
  return Object.freeze({
    get available() {
      return view.available;
    },
    get: view.get,
    list: view.list,
    verifyToken: view.verifyToken,
    deferredPrincipal: view.deferredPrincipal,
    reidentificationDeviation: view.reidentificationDeviation,
    eventScope: view.eventScope,
    resume: (request: ResumeRequest, options?: RevivalOptions) =>
      reviveDeferral(context, request, options),
    sweep,
    mintToken(id: string, options?: { readonly callBinding?: string }) {
      return requireContinuations(
        context,
        "Minting a resume token",
      ).signer.mint(id, new Date(), options?.callBinding);
    },
    async rewriteStepState(
      id: string,
      rewrite: (state: unknown) => unknown | Promise<unknown>,
    ) {
      const { store } = requireContinuations(
        context,
        "Rewriting a deferral's step state",
      );
      const record = await store.get(id);
      if (!record) return { won: false, deferral: undefined };
      // Not attempted on a settled or claimed record: the store would refuse the swap anyway.
      if (!resumable(record)) return { won: false, deferral: live(record) };
      const expected = stepStateFingerprint(record.stepState);
      const next = await rewrite(
        record.stepState === undefined
          ? undefined
          : decodePersistable(record.stepState, "stepState"),
      );
      const cas = await store.replaceStepState(
        id,
        expected,
        encodePersistable(next, "stepState"),
      );
      return cas.deferral ? { ...cas, deferral: live(cas.deferral) } : cas;
    },
  });
}

/**
 * The parked exchanges of the application an exchange runs in, to read.
 * The acts (resume, mint, rewrite, sweep) are on `c.continuations`, which a
 * plugin receives in its hooks.
 */
export function continuationsOf(exchange: Exchange): ContinuationsView {
  return continuationsView(getExchangeContext(exchange));
}
