/**
 * Whether a deferred exchange is still waiting or has settled.
 *
 * Two values, because the five that came before were answers to three
 * different questions. What the work is waiting FOR is
 * {@link Deferral.waitingFor}; how it settled is {@link Deferral.outcome};
 * whether a delivery claim is outstanding is {@link Deferral.claimedAt}. A
 * reader asks one of those and reads the field that answers it, instead of
 * inferring all three from which of five values a record landed on.
 *
 * A deferral is resumable while it is `waiting` AND unclaimed. The claim is
 * a second axis rather than a third state: whoever holds it owns telling the
 * route, and a claim whose holder died is released by
 * {@link DeferralStore.releaseClaims} once its lease elapses, so the next
 * sweep redelivers. Every transition goes through the store's
 * compare-and-swap methods so exactly one caller wins a race between a
 * resume, a sweep, and a cancellation.
 */
export type DeferralState = "waiting" | "settled";

/**
 * What a deferral is waiting for.
 *
 * One value today: `.defer()` waits for somebody to call `.resume()`. It is
 * a stored field rather than an implied constant so a management surface can
 * group by it, and so the kinds #737 and #738 add (asking a person, handing
 * work outside the process) widen this union instead of introducing a second
 * vocabulary beside it.
 *
 * Kept on a settled record too, because it says what the work WAS waiting
 * for. That is what makes "expired while waiting for a resume" readable off
 * one record rather than reconstructed from two.
 */
export type DeferralWaitingFor = "resume";

/**
 * Keyset cursor for {@link DeferralStore.findExpired}.
 *
 * Pages advance strictly past `(expiresAt, id)`, so a record the caller
 * visited and could not retire is never re-read by the same pass, whatever
 * its state. That is what makes an arbitrarily long unretirable prefix
 * unable to starve the records behind it.
 */
export interface ExpiredScanCursor {
  readonly expiresAt: Date;
  readonly id: string;
}

/**
 * Keyset cursor for {@link DeferralStore.list}.
 *
 * A deferral id is `{exchangeId}#{sequence}` and an exchange id is a uuid,
 * so id order says nothing about time. The listing is ordered by
 * `(deferredAt, id)` instead, which is the order an operator reads it in:
 * what has been waiting longest is what they are looking for.
 */
export interface DeferralListCursor {
  readonly deferredAt: Date;
  readonly id: string;
}

/**
 * What {@link DeferralStore.list} is being asked for.
 *
 * `state` defaults to `waiting` at the caller rather than here, because a
 * store implementation must not have to know which half of the collection
 * a management surface considers interesting.
 */
export interface DeferralListQuery {
  /** Only deferrals in this state. Both states when absent. */
  readonly state?: DeferralState;
  /** Only deferrals belonging to this route. */
  readonly routeId?: string;
  /** Bound on one page. A non-positive or non-integer value throws. */
  readonly limit: number;
  /** Resume strictly past this position in `(deferredAt, id)` order. */
  readonly after?: DeferralListCursor;
}

/**
 * One deferral as a management surface presents it.
 *
 * A projection rather than the record, and deliberately so: the record
 * carries the serialized exchange, the step state and the resume-payload
 * schema, none of which a listing may show and none of which it should
 * pull into memory a page at a time to then drop. What a reader needs is
 * what it is waiting for, how long it has waited, and whether anything
 * already holds it.
 */
export interface DeferralSummary {
  readonly id: string;
  readonly routeId: string;
  readonly state: DeferralState;
  /** What the work is waiting for, or was waiting for when it settled. */
  readonly waitingFor: DeferralWaitingFor;
  /**
   * Whether a delivery claim is outstanding, rather than when it was
   * taken. A reader asks whether anything already owns telling the route,
   * and the timestamp is an implementation detail of the lease.
   */
  readonly claimed: boolean;
  readonly deferredAt: Date;
  /** When the sweeper will expire it. Absent means no deadline. */
  readonly expiresAt?: Date;
  /** How it settled. Absent while it is waiting. */
  readonly outcome?: DeferralOutcome;
}

/**
 * Project a stored record onto what a management surface may see.
 *
 * Named once and shared by both backends so a field can never reach the
 * listing from one store and not the other, and so the exchange has one
 * place it is dropped rather than one per backend.
 */
export function summariseDeferral(deferral: Deferral): DeferralSummary {
  return {
    id: deferral.id,
    routeId: deferral.routeId,
    state: deferral.state,
    waitingFor: deferral.waitingFor,
    claimed: deferral.claimedAt !== undefined,
    deferredAt: deferral.deferredAt,
    ...(deferral.expiresAt !== undefined
      ? { expiresAt: deferral.expiresAt }
      : {}),
    ...(deferral.outcome !== undefined ? { outcome: deferral.outcome } : {}),
  };
}

/**
 * The persisted form of a deferred exchange: exactly the two stored slots of
 * `Exchange` (`body` and `headers`), per
 * `.standards/exchange-state-model.md`. Derivations (`id`, `principal`,
 * `logger`) are rebuilt by constructing a `DefaultExchange` around these
 * two on the resuming process, so there is nothing else to persist.
 *
 * Both slots are plain JSON data. `serializeExchange` refuses anything else
 * with `RC5042` rather than writing a value the store cannot round-trip.
 */
export interface SerializedExchange {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, unknown>>;
}

/**
 * How the resume-payload schema is carried on a stored deferral.
 *
 * A Standard Schema is a live object with a validate function, so it cannot
 * be persisted. What is persisted is a reference: the `(routeId, position)`
 * pair on the record identifies the deferring step, whose live `schema` is
 * read back off the route at resume time, and `hash` is folded into
 * `continuationHash` so a schema that changed under a deferred exchange fails
 * the compatibility check rather than validating against the wrong
 * contract.
 *
 * `jsonSchema` is populated opportunistically from the non-standard
 * `~standard.jsonSchema` extension that Zod, ArkType and the AI SDK bridge
 * expose. It is descriptive only: it tells a caller and an operator what a
 * a valid resume payload looks like. Validation always runs against the live schema.
 *
 * A site that declares NO schema still gets a descriptor, carrying
 * {@link DeferralSchema.absent}. That sentinel is deliberately distinct
 * from the degraded fallback below: without it, editing a site from a
 * declared-but-unrenderable schema to no schema at all would leave the
 * digest unmoved, so a recipient told there was a contract would have their
 * payload accepted unvalidated with no re-ask.
 */
export interface DeferralSchema {
  /** Stable hash of the resume-payload schema, or the absent sentinel. */
  readonly hash: string;
  /** Set when the site declared no schema at all. */
  readonly absent?: boolean;
  /** JSON Schema rendering when the schema exposes one. Never used to validate. */
  readonly jsonSchema?: unknown;
  /**
   * Set when the schema advertised a `~standard.jsonSchema` extension that
   * then produced nothing, so {@link DeferralSchema.hash} identifies only
   * the vendor rather than the contract.
   *
   * The consequence is worth stating where it is read: the step tail is
   * still hashed, but a widened or narrowed schema of that kind cannot
   * move the digest, so a resume will not catch it. Zod throws for
   * unrepresentable types (a `Date`, a `bigint`, any `.transform()`), which
   * makes this reachable with an ordinary approval schema.
   */
  readonly degraded?: boolean;
}

/**
 * Audit record of who resumed a deferral.
 *
 * A subset of `Principal` rather than the principal itself: the store is a
 * persistence surface, and a full principal carries claims, scopes and a
 * delegation chain that would be resurrected as data with no verification
 * behind it. What is recorded is enough to answer "who authorized this",
 * which is what the receipt is for.
 */
export interface PrincipalRef {
  readonly subject: string;
  readonly issuer?: string;
  readonly clientId?: string;
  /** The outermost actor's subject when a delegate resumed on someone's behalf. */
  readonly actorSubject?: string;
}

/**
 * How a deferral settled.
 *
 * Present exactly when {@link Deferral.state} is `settled` and absent
 * exactly while it is `waiting`. Nothing in the type system enforces that
 * pairing; the store's transitions do, because every one of them writes
 * `state` and `outcome` in the same compare-and-swap.
 */
export interface DeferralOutcome {
  /** Which way it ended. */
  readonly kind: "resumed" | "expired" | "denied";
  /**
   * When the record left the waiting state. This is the retention clock:
   * {@link DeferralStore.purgeSettled} measures from here, so a record that
   * waits for months and settles today is kept for the full retention
   * window from today.
   */
  readonly at: Date;
  /** Why a `denied` deferral was denied (cancellation, operator action). */
  readonly reason?: string;
  /** Who resumed it. Only ever set on a `resumed` outcome. */
  readonly by?: PrincipalRef;
}

/**
 * The cached result of execution two, written once the resumed exchange
 * settles. A duplicate resume returns this instead of running the
 * continuation a second time.
 */
export interface SerializedOutcome {
  /**
   * How execution two ended. `deferred` is the two-stage-approval case:
   * the continuation reached ANOTHER `.defer()` and deferred again, so the
   * work is neither finished nor failed. It is recorded distinctly because
   * calling it `completed` would tell a receipt, a dashboard, and every
   * duplicate resume that the work finished while it is still waiting on
   * the next resume.
   */
  readonly status: "completed" | "failed" | "dropped" | "deferred";
  /** Terminal body on a completed run. Plain JSON data, same rule as {@link SerializedExchange}. */
  readonly body?: unknown;
  /** Error code and message on a failed run. The stack is deliberately not persisted. */
  readonly error?: { readonly rc?: string; readonly message: string };
  /** Drop reason on a dropped run. */
  readonly reason?: string;
  readonly at: Date;
}

/**
 * A deferred exchange plus everything needed to revive it.
 *
 * The record is deliberately free of anything agent-shaped. A deferring
 * step that needs to carry closure state of its own puts it in
 * {@link Deferral.stepState}, which the store never interprets; that one
 * opaque slot is what lets the agent tier (#258) share this store instead
 * of growing a second one.
 */
export interface Deferral {
  /** Deferral identity. Distinct from the deferred exchange's own id. */
  readonly id: string;
  /** Route the deferred exchange belongs to. Resume re-enters this route. */
  readonly routeId: string;
  /** Index of the deferring step. Execution two resumes at `position + 1`. */
  readonly position: number;
  /**
   * Hash over steps `position + 1` to the end of the pipeline, plus the
   * resume-payload schema descriptor.
   *
   * {@link Deferral.meta} is deliberately NOT folded in. It lives only on
   * the record, so it has no live copy to drift from: a defer site that
   * snapshots its policy there is protected by where the value lives rather
   * than by a tamper check.
   *
   * Covers step DEFINITIONS only: what a `direct()` route the tail forwards
   * to actually does, which version an adapter is on, and how an external
   * system behaves can all change without moving this hash. See
   * {@link continuationHash}.
   */
  readonly continuationHash: string;
  readonly exchange: SerializedExchange;
  readonly schema: DeferralSchema;
  /**
   * Whatever the deferring step attached at deferral, persisted verbatim and
   * handed back to the resume route's `authorize` hook.
   *
   * The framework never reads it. Who may resume a deferred run is the
   * application's policy, and this is where the deferral carries whatever that
   * policy needs: a channel name, the roles the defer site required, an amount,
   * a snapshot of the policy in force at deferral time. Subject to the same
   * plain-JSON rule as the exchange (`RC5042`).
   *
   * On the agent surface it is supplied by a tool handler, which means the
   * MODEL influenced it. Treat it as data the defer site chose, not as a fact
   * the framework vouches for.
   */
  readonly meta?: unknown;
  /**
   * Which call this record belongs to, when the deferring step mints one
   * credential per call.
   *
   * A batch of parallel tool calls shares one record (one deferral) while each
   * handler sends its own recipient a link. Only the call that actually won
   * the deferral may be resumed, so its identity is recorded here and every
   * credential carries the same value as its `sub` claim. A losing sibling's
   * recipient then takes `RC5055` rather than resuming a deferral that was never
   * theirs.
   *
   * Absent for an ordinary `.defer()`, where there is nothing to
   * disambiguate.
   */
  readonly callBinding?: string;
  /**
   * Opaque state owned by the deferring step. Absent for an ordinary step;
   * an agent step puts its messages thread and outstanding tool-call id
   * here. The store persists it verbatim and never reads into it, so it is
   * subject to the same JSON-data rule as the exchange.
   */
  readonly stepState?: unknown;
  /**
   * Binds an approval to the operation it authorized rather than to a
   * deferral id, so a receipt reads "this principal authorized this exact
   * operation". See {@link actionFingerprint}.
   */
  readonly actionFingerprint: string;
  readonly deferredAt: Date;
  /** When the sweeper will expire this deferral. Absent means no TTL. */
  readonly expiresAt?: Date;
  /**
   * When the outstanding delivery claim was taken, which is BEFORE the
   * notification: it is a claim timestamp, not proof of delivery. Set only
   * on a `waiting` record, cleared when a stale claim is released, and kept
   * on a settled one as the record of who got there first.
   *
   * Load-bearing rather than informational: a claimed record is not
   * resumable, because the claim holder owns the outcome. That is the
   * compare every transition out of `waiting` makes.
   */
  readonly claimedAt?: Date;
  readonly state: DeferralState;
  readonly waitingFor: DeferralWaitingFor;
  /** How it settled. Absent while {@link Deferral.state} is `waiting`. */
  readonly outcome?: DeferralOutcome;
  /** Cached result of execution two, for idempotent re-resume. */
  readonly continuation?: SerializedOutcome;
}

/**
 * A deferral as it is handed to {@link DeferralStore.create}.
 *
 * A record is born `waiting`, so the fields only a transition can produce
 * are not part of the input. Taking a full {@link Deferral} would let a
 * caller insert a record that is already settled, and every compare-and-swap
 * in the contract then refuses to move it: the exchange is deferred
 * permanently, with no error to notice.
 */
export type NewDeferral = Omit<Deferral, DeferralTransitionField> & {
  // Declared as optional `never` rather than merely omitted. A plain `Omit`
  // is satisfied by a full `Deferral` variable, because excess-property
  // checking only fires on a fresh object literal, so the one shape most
  // likely to carry a settled status (a record read back out of the store
  // and handed to `create`) would have passed unremarked.
  readonly [K in DeferralTransitionField]?: never;
};

/**
 * The fields only a `mark*` transition may write.
 */
type DeferralTransitionField =
  "state" | "outcome" | "continuation" | "claimedAt";

/**
 * Details recorded when a resume wins the compare-and-swap.
 */
export interface DeferralResumption {
  readonly at: Date;
  readonly by?: PrincipalRef;
}

/**
 * Result of a compare-and-swap on a deferral.
 *
 * `won` is the load-bearing field: it reports whether THIS caller performed
 * the transition. A resume arriving at the same moment the sweeper expires
 * the deferral produces exactly one `won: true`, and the loser reads
 * `deferral.outcome` to find out what happened instead.
 *
 * `deferral` is the record as it stands after the attempt, so a loser
 * does not need a second read to react. It is `undefined` only when the id
 * is unknown.
 */
export interface DeferralCasResult {
  readonly won: boolean;
  readonly deferral: Deferral | undefined;
}

/**
 * What the startup scan reports at info level.
 */
export interface PendingDeferralSummary {
  /** Deferrals still waiting. */
  readonly count: number;
  /** `deferredAt` of the oldest of them, absent when there are none. */
  readonly oldest?: Date;
}

/**
 * Whether a deferral can still be resumed: waiting, with no delivery claim
 * outstanding.
 *
 * The two-field condition every transition out of waiting compares against,
 * named once so the stores, the revival path and the sweeper cannot drift on
 * it. A claimed record is deliberately excluded even though it is still
 * waiting: the claim holder owns the outcome, and letting a resume in behind
 * it would produce two notifications for one event.
 */
export function resumable(deferral: Deferral): boolean {
  return deferral.state === "waiting" && deferral.claimedAt === undefined;
}

/**
 * Whether a delivery claim is outstanding on a waiting deferral, which is
 * what {@link DeferralStore.markExpired} and
 * {@link DeferralStore.markDenied} settle.
 */
export function claimed(
  deferral: Deferral,
): deferral is Deferral & { readonly claimedAt: Date } {
  return deferral.state === "waiting" && deferral.claimedAt !== undefined;
}

/**
 * Persistence contract for deferred exchanges.
 *
 * Two backends ship: {@link MemoryDeferralStore} for tests and ephemeral
 * use, and {@link SqliteDeferralStore} as the durable default wherever
 * the runtime allows. Postgres and redis are out of scope; the contract is
 * shaped so they can be added without touching call sites, which is why
 * every method is async and why the state transitions are compare-and-swap
 * rather than read-then-write.
 *
 * Implementations must treat the three `mark*` methods as atomic with
 * respect to each other. Single-node coordination is all that is required
 * today, but a read-then-write implementation cannot be made safe later
 * without a rewrite, and the atomic form costs nothing now.
 */
export interface DeferralStore {
  /**
   * Persist a newly deferred exchange. Throws if `record.id` already exists:
   * a deferral id is minted per defer and a collision means a bug, not
   * a retry. The stored record is `waiting` and unclaimed; only the
   * transitions below move it.
   */
  create(record: NewDeferral): Promise<void>;

  /** Load a deferral by id. `undefined` when the id is unknown. */
  get(id: string): Promise<Deferral | undefined>;

  /**
   * Settle an unclaimed waiting deferral as `resumed`, recording who resumed
   * it and when. Exactly one concurrent caller wins.
   */
  markResumed(
    id: string,
    resumption: DeferralResumption,
  ): Promise<DeferralCasResult>;

  /**
   * Claim an unclaimed waiting deferral for delivery, recording when the
   * claim was taken. The record stays `waiting`, which is the point: a claim
   * is not an outcome. Winning it is the right to notify the route, and the
   * caller delivers the re-ask and then settles with
   * {@link DeferralStore.markExpired} or {@link DeferralStore.markDenied}. A
   * holder that dies mid-delivery is healed by
   * {@link DeferralStore.releaseClaims} rather than leaving the record
   * stuck.
   *
   * A released EXPIRY claim is overdue, so the next sweep redelivers it. A
   * released DENIAL claim is not, so its redelivery waits for the next
   * replay of the token, or for the deadline, whichever comes first; the
   * proactive nag is lost only for a record that has no deadline and is
   * never replayed, which is the pre-lease behaviour for every crash.
   */
  claimExpiry(id: string, at: Date): Promise<DeferralCasResult>;

  /**
   * Settle a claimed deferral as `expired`, stamping
   * {@link DeferralOutcome.at} at the write. `expiresAt` still says when the
   * deferral came due and `claimedAt` when its delivery was claimed; the
   * outcome's own timestamp is when the record actually stopped waiting,
   * which is what retention measures from.
   */
  markExpired(id: string): Promise<DeferralCasResult>;

  /**
   * Settle a claimed deferral as `denied`, stamping
   * {@link DeferralOutcome.at} at the write.
   * The claim-first shape applies to denial for the same reason as expiry:
   * a crash between the transition and the notification must heal by
   * redelivery, not strand the approver. Cancellation (#552) will claim
   * first too.
   */
  markDenied(id: string, reason?: string): Promise<DeferralCasResult>;

  /**
   * Release every delivery claim taken at or before `before` by clearing
   * {@link Deferral.claimedAt}, and report how many were released. The
   * records were and remain `waiting`; what changes is that they are
   * resumable and sweepable again.
   *
   * This is the healing half of the claim: a released record is past its
   * deadline, so the next ordinary sweep pass redelivers it. A crash after
   * delivery but before finalize therefore costs one duplicate escalation
   * after the lease elapses, which is the accepted at-least-once trade;
   * a crash before delivery costs nothing but the lease's delay.
   */
  releaseClaims(before: Date): Promise<number>;

  /**
   * Compare-and-swap the opaque {@link Deferral.stepState} slot of a
   * record that is STILL waiting and unclaimed, leaving every other field
   * alone.
   *
   * The one write that edits a waiting record in place rather than settling
   * it. Compaction is the motivating caller: an agent's deferred thread grows
   * past what the model will accept, and shrinking it has to happen while
   * the exchange stays deferred, because a resume that lands on an
   * unshrinkable thread has nowhere to go.
   *
   * Two races are closed by the same compare. `expected` is the
   * `stepStateFingerprint` of the state the caller read and rewrote, so two
   * compactions of the same record produce one winner and one `won: false`
   * holding the state that landed, instead of the second silently
   * discarding the first. And the swap only matches an unclaimed waiting
   * row, so a resume or a sweep that got there first wins outright: the compaction is
   * refused rather than rewriting the thread of a run that is already
   * executing its continuation.
   *
   * The store still never reads INTO the slot. Whether the replacement is a
   * usable thread is the owning tier's question, and `@routecraft/ai`
   * answers it before calling this.
   *
   * @param id - Deferral whose step state is being replaced
   * @param expected - Fingerprint of the step state the caller based its
   *   replacement on, from `stepStateFingerprint`
   * @param stepState - The replacement. Subject to the same plain-JSON rule
   *   as every other free-form slot (`RC5042`). `undefined` clears the slot
   *   on every backend.
   */
  replaceStepState(
    id: string,
    expected: string,
    stepState: unknown,
  ): Promise<DeferralCasResult>;

  /**
   * Cache the result of execution two so a duplicate resume can reply
   * without re-running the continuation. Silently ignores an unknown id: the
   * cache is a convenience, and losing the race to a sweep must not turn
   * into a second failure on the way out.
   *
   * Unconditional by design: only the caller that won `markResumed` ever
   * writes a continuation, so there is no competing writer for this row and
   * a compare would defend nothing.
   */
  recordContinuation(
    id: string,
    continuation: SerializedOutcome,
  ): Promise<void>;

  /**
   * Deferrals still waiting and unclaimed whose `expiresAt` is at or
   * before `now`, ordered by `(expiresAt ASC, id ASC)` and starting
   * strictly after `after` when one is given. `limit` bounds one page so a
   * backlog accumulated while the process was down does not produce an
   * unbounded batch.
   *
   * The ordering is a strict total order within a backend, which is what
   * makes the cursor sound; it is not guaranteed byte-identical across
   * backends for non-ASCII ids, so a cursor must only ever be replayed
   * against the store that produced it.
   *
   * A non-positive or non-integer `limit`, or a malformed `after`, is a
   * caller error and throws rather than being interpreted.
   */
  findExpired(
    now: Date,
    limit: number,
    after?: ExpiredScanCursor,
  ): Promise<Deferral[]>;

  /** Count and oldest `deferredAt` across deferrals still waiting. */
  pending(): Promise<PendingDeferralSummary>;

  /**
   * One page of deferrals as a management surface presents them, ordered
   * `(deferredAt ASC, id ASC)` and starting strictly after
   * {@link DeferralListQuery.after} when one is given.
   *
   * Ordered by time rather than by id because a deferral id is
   * `{exchangeId}#{sequence}` over a uuid, so id order is arbitrary and a
   * listing in it answers no question anyone asks. Oldest first is the
   * question: what has been waiting longest.
   *
   * A projection rather than the records, so the serialized exchange, the
   * step state and the resume-payload schema never enter the read path at
   * all. The listing must not show them, and a store that returned whole
   * records would page a hundred thousand exchange bodies through memory
   * on the way to dropping them.
   *
   * The ordering is a strict total order within a backend, and as with
   * {@link DeferralStore.findExpired} it is not guaranteed byte-identical
   * across backends for non-ASCII ids, so a cursor is only ever replayed
   * against the store that produced it.
   *
   * A non-positive or non-integer `limit` is a caller error and throws
   * rather than being interpreted.
   */
  list(query: DeferralListQuery): Promise<DeferralSummary[]>;

  /**
   * Records settled as `resumed` whose continuation never landed, oldest
   * first.
   *
   * This is crash residue. A resume wins the compare-and-swap out of
   * `waiting` BEFORE running the continuation and caches the result after,
   * so a record in this state means the process died between the two.
   * The approval is spent, the work half ran, and nothing will ever revisit
   * it: it is invisible to {@link DeferralStore.findExpired}, which only
   * looks at waiting records.
   *
   * Re-running a
   * continuation whose side effects may have half happened needs a lease on
   * the resumed outcome and idempotent continuations, which is the
   * admission-and-idempotency work tracked separately. What this method is
   * for is the boot summary after an outage, which is the first moment
   * anyone could learn such a record exists.
   *
   * The asymmetry with the delivery claim is deliberate: expiry
   * NOTIFICATIONS heal by redelivery because re-sending a nag is safe,
   * while this residue is a half-run CONTINUATION and is only ever
   * reported.
   *
   * @param limit - Cap on records returned. Omit for all of them.
   */
  resumedWithoutContinuation(limit?: number): Promise<Deferral[]>;

  /**
   * Delete settled deferrals whose {@link DeferralOutcome.at} is before
   * `before`, and report how many went.
   *
   * A settled record holds a full serialized exchange body plus its cached
   * continuation, and nothing else ever removes one. Without a
   * retention path a long-running process accumulates every exchange that
   * ever deferred: on disk under sqlite, and on the heap under the
   * in-memory backend, which is also the automatic fallback for a Node
   * install without a driver. Waiting records are never touched, whatever
   * their age; expiring them is the sweeper's job and goes through
   * {@link DeferralStore.markExpired}.
   *
   * The cutoff is the outcome's timestamp, not `deferredAt`: retention
   * promises how long a SETTLED record is kept, and measuring from the
   * deferral would purge a record that waited 89 days and settled on day 89
   * one day after it settled.
   */
  purgeSettled(before: Date): Promise<number>;

  /** Release backend resources. Idempotent. */
  close(): Promise<void>;
}
