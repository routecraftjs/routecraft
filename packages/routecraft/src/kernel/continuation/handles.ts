import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { CraftContext } from "../../context.ts";
import { rcError } from "../../error.ts";
import { peekRevival, type Exchange } from "../../exchange.ts";
import type { Route } from "../../route.ts";
import { anySignal } from "../../shared/abort.ts";
import { type Duration, parseDuration } from "../../shared/duration.ts";
import { authorityOf } from "../authority.ts";
import type { Deferred } from "./deferred.ts";
import { deferAside } from "./park.ts";
import { principalRef } from "./principal-ref.ts";
import {
  type ResumeAcknowledgment,
  type ResumeDoor,
  type ResumeRequest,
  reviveDeferral,
} from "./resume.ts";
import { DeferSignal } from "./signal.ts";
import {
  type DeclaredDeferSite,
  type DeferDeclaration,
  mintDeferTicket,
} from "./sites.ts";

/** What a step hands `ctx.defer()` when it defers the exchange. */
export interface DeferRequest {
  /** How long the deferral stays resumable. Absent means the application's default. */
  readonly ttl?: Duration;
  /**
   * Anything the resuming side needs to decide who may resume. Persisted
   * as written and never interpreted by the framework.
   */
  readonly meta?: unknown;
  /**
   * Identity of the call this deferral belongs to, when the step mints one
   * credential per call: a token minted for another call cannot resume it.
   */
  readonly callBinding?: string;
  /**
   * State the step needs to finish its work when it runs again, handed back
   * as `ctx.defer.revived.stepState`. A `"this-step"` site only.
   */
  readonly stepState?: unknown;
  /**
   * What a valid resume payload looks like, for a `"this-step"` site: a
   * `"next-step"` site declares its own. It is rendered onto the
   * acknowledgment and folded into the continuation digest; the payload is
   * handed back unvalidated, because the schema lives in the step's code
   * and the step is its validator.
   */
  readonly input?: StandardSchemaV1;
  /**
   * Tell someone the exchange deferred. Awaited after the record is written
   * and before `route:exchange:deferred`, with the acknowledgment whose
   * `token` resumes it. A throw, or a hook that does not settle before the
   * run is cancelled, is `RC5067` and the record is denied: nobody was
   * told, so nobody holds a working link.
   */
  readonly notify?: (ack: Deferred) => void | Promise<void>;
}

/** What a step hands `ctx.defer.aside()`. */
export interface DeferAsideRequest {
  /** Built from the deferral id, so the state a revival hands back can name its record. */
  readonly stepState: (deferralId: string) => unknown;
  /**
   * Awaited with the id before the record is written, and given no token:
   * the caller's own record can name the deferral from its first write, so
   * a crash between the two leaves a reference to release, not a record
   * nothing points at.
   */
  readonly announce?: (deferralId: string) => Promise<void>;
}

/** What a revived `"this-step"` step reads to finish what it deferred. */
export interface DeferRevival {
  readonly deferralId: string;
  /** What the step stored when it deferred. */
  readonly stepState: unknown;
  /** The resume payload, as submitted. */
  readonly input: unknown;
}

/**
 * Handed as `ctx.defer` to a step that declares `DEFERS`, and to the
 * adapter of a `.to()` / `.enrich()` that declares it.
 */
export interface DeferHandle {
  /**
   * End the run deferred. The promise never resolves: it rejects with the
   * kernel's own signal, which the kernel turns into the deferral where the
   * step was run, so no enclosing `.retry()` runs the step again. Await it
   * or return it; code that catches the rejection lets it through
   * (`isDeferSignal`).
   *
   * @throws RC5051 when the step sits where a deferral cannot be revived
   *   from ({@link DeferHandle.refused})
   * @throws RC5003 when a `"next-step"` site is handed `input` or
   *   `stepState`
   */
  (request?: DeferRequest): Promise<never>;
  /** Set when this run is a revival of a deferral this step raised. */
  readonly revived?: DeferRevival;
  /**
   * Why a deferral from this step cannot be revived, when it cannot: the
   * step is inside a `.split()` fan-out, a `.multicast()` path or a
   * `.dispatch()` target. Deferring anyway is `RC5051` with this text.
   */
  readonly refused?: string;
  /**
   * Store a continuation for an exchange that goes on to complete: a way
   * to run this step again later, with the exchange as it is now. No
   * acknowledgment, no token and no `route:exchange:deferred`. A
   * `"this-step"` site only.
   */
  aside(request: DeferAsideRequest): Promise<{ readonly deferralId: string }>;
}

/**
 * `ctx.defer` as a `"next-step"` site holds it: the step does not run
 * again, so it has no state to store, no revival to read and no
 * continuation to set aside, and its `input` is the one it declared.
 */
export interface NextStepDeferHandle {
  (request?: Omit<DeferRequest, "stepState" | "input">): Promise<never>;
  readonly refused?: string;
}

/** `ctx.defer` for a step, by the revival it declared. */
export type DeferHandleFor<D extends DeferDeclaration> = D extends {
  readonly revival: "next-step";
}
  ? NextStepDeferHandle
  : DeferHandle;

/**
 * Handed as `ctx.resume` to a step that declares `RESUMES`. The exchange,
 * the principal it carries, the route and `resumedBy` are the kernel's: the
 * resuming party recorded is the principal this route verified, and a
 * request that names one is refused (`RC5003`).
 */
export type ResumeFn = (
  request: Omit<ResumeRequest, "resumedBy">,
  door?: Pick<ResumeDoor, "authorize" | "elevate" | "signal">,
) => Promise<ResumeAcknowledgment>;

/**
 * The `RC5051` text for a deferring step the site walk never resolved.
 *
 * @internal
 */
export function unbuiltRefusal(what: string): string {
  return `${what} is not reachable from a built route, so the framework cannot work out what would run when it resumes. Build the route through craft()...build() rather than assembling a RouteDefinition by hand.`;
}

const raised = new WeakSet<DeferHandle>();

/**
 * Whether `ctx.defer()` was called on this handle. A step that called it
 * and still returned caught the rejection or never awaited it, and the
 * exchange would run on past the point it asked to stop at.
 *
 * @internal
 */
export function deferWasRaised(handle: DeferHandle): boolean {
  return raised.has(handle);
}

const UNBUILT = unbuiltRefusal("This step declares DEFERS but");

/**
 * Build the handle for one execution of a step that declares `DEFERS`.
 *
 * @param declared - What the site walk resolved for the step, or
 *   `undefined` when its route never went through the walk
 * @internal
 */
export function deferHandleFor(
  context: CraftContext,
  routeId: string,
  exchange: Exchange,
  declared: DeclaredDeferSite | undefined,
): DeferHandle {
  const refused =
    declared === undefined
      ? UNBUILT
      : declared.kind === "refused"
        ? declared.refusal
        : undefined;
  const siteOf = (): Extract<DeclaredDeferSite, { kind: "site" }> => {
    if (declared?.kind !== "site") {
      throw rcError("RC5051", undefined, { message: refused ?? UNBUILT });
    }
    return declared;
  };
  const raise = async (request: DeferRequest): Promise<never> => {
    const resolved = siteOf();
    const { ttl, meta, callBinding, stepState, input, notify } = request;
    if (
      resolved.revival === "next-step" &&
      (input !== undefined || stepState !== undefined)
    ) {
      throw rcError("RC5003", undefined, {
        message: `ctx.defer() on route "${routeId}" was given ${input !== undefined ? '"input"' : '"stepState"'}, which a "next-step" site does not take: it declares its input through DEFERS, and it does not run again, so it has no state to hand back.`,
      });
    }
    const schema = resolved.input ?? input;
    throw new DeferSignal(
      mintDeferTicket({
        site: resolved.site,
        ...(schema !== undefined ? { schema } : {}),
        ...(ttl !== undefined
          ? { expiresInMs: parseDuration(ttl, "defer({ ttl })") }
          : {}),
        ...(meta !== undefined ? { meta } : {}),
        ...(callBinding !== undefined ? { callBinding } : {}),
        ...(stepState !== undefined ? { stepState } : {}),
        ...(notify !== undefined ? { notify } : {}),
      }),
    );
  };
  const defer = (request: DeferRequest = {}): Promise<never> => {
    const rejection = raise(request);
    // Observed here so a call nobody awaited is reported by the kernel, not as an unhandled rejection.
    rejection.catch((err: unknown) => {
      if (err instanceof DeferSignal) raised.add(handle);
    });
    return rejection;
  };
  const handle: DeferHandle = Object.defineProperties(defer, {
    revived: {
      get: () =>
        declared?.revival === "this-step" ? peekRevival(exchange) : undefined,
      enumerable: true,
    },
    refused: { value: refused, enumerable: true },
    aside: {
      value: async (request: DeferAsideRequest) => {
        const resolved = siteOf();
        if (resolved.revival !== "this-step") {
          throw rcError("RC5003", undefined, {
            message: `ctx.defer.aside() on route "${routeId}" was called from a "next-step" site. A continuation stored aside runs its step again, so only a "this-step" site can store one.`,
          });
        }
        return deferAside(
          context,
          exchange,
          resolved.site,
          routeId,
          request.stepState,
          request.announce,
        );
      },
    },
  }) as DeferHandle;
  return handle;
}

/**
 * Build `ctx.resume` for one execution of a step that declares `RESUMES`.
 *
 * @internal
 */
export function resumeFnFor(
  context: CraftContext,
  route: Route | undefined,
  exchange: Exchange,
): ResumeFn {
  return async (request, door = {}) => {
    if ((request as ResumeRequest).resumedBy !== undefined) {
      throw rcError("RC5003", undefined, {
        message:
          'A resume step named "resumedBy". The kernel records the principal the resuming route verified, and a door does not get to name another. A plugin that resumes on someone\'s behalf calls continuations.resume() in its own code.',
      });
    }
    // Only a principal this route verified live may stand as the resuming
    // party: a revived exchange carries its parked principal back marked
    // restored, which is storage data.
    const authority = authorityOf(exchange);
    const claimed = authority.read(exchange);
    const live =
      claimed && !authority.isRestored(claimed) ? claimed : undefined;
    // Intake as well as the caller's signal: a route with no .timeout() must
    // still be able to interrupt a hook that never settles.
    const signal = anySignal(route?.intakeSignal, door.signal);
    return reviveDeferral(
      context,
      {
        token: request.token,
        input: request.input,
        ...(live ? { resumedBy: principalRef(live) } : {}),
      },
      {
        ...(door.authorize !== undefined ? { authorize: door.authorize } : {}),
        ...(door.elevate !== undefined ? { elevate: door.elevate } : {}),
        ...(live ? { principal: live } : {}),
        ...(signal ? { signal } : {}),
        ...(route ? { routeId: route.definition.id } : {}),
        exchangeId: exchange.id,
      },
    );
  };
}
