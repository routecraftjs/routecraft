import type { Exchange, Plugin, Step } from "../contracts/index.ts";
import { token } from "../contracts/index.ts";
import { STORE_API, type RecordStore } from "./stores.ts";

/**
 * The acceptance test for the whole design, in miniature.
 *
 * Deferral is the subsystem the register measures at 202 references across
 * 14 core files. Here it is a plugin that touches core only through the
 * declared seams: one dependency, one provided API, one step, one wrapper,
 * one handler, one exchange extension.
 */
export interface DeferralApi {
  defer(exchange: Exchange, reason: string): Promise<string>;
  resume(id: string): Promise<boolean>;
  waiting(): Promise<readonly string[]>;
}

export const DEFERRAL_API = token<DeferralApi>("routecraft.deferral.api");

/** What `ex.use(DEFERRAL_EXT)` returns. The `ex.deferral` of today. */
export interface DeferralAffordance {
  defer(reason: string): Promise<string>;
}

export const DEFERRAL_EXT = token<DeferralAffordance>(
  "routecraft.deferral.exchange",
);

class Deferrals implements DeferralApi {
  #seq = 0;
  constructor(private readonly store: RecordStore) {}

  async defer(exchange: Exchange, reason: string): Promise<string> {
    const id = `def-${++this.#seq}`;
    await this.store.put(`deferral/${id}`, {
      exchangeId: exchange.id,
      reason,
      status: "waiting",
    });
    await this.store.put(`idx/waiting/${id}`, null);
    return id;
  }

  async resume(id: string): Promise<boolean> {
    const row = await this.store.get(`deferral/${id}`);
    if (row === undefined) return false;
    const record = row.value as { status: string };
    if (record.status !== "waiting") return false;
    const won = await this.store.put(
      `deferral/${id}`,
      { ...record, status: "resumed" },
      { ifVersion: row.version },
    );
    if (!won.won) return false;
    await this.store.put(`idx/waiting/${id}`, undefined);
    return true;
  }

  async waiting(): Promise<readonly string[]> {
    const keys = await this.store.list("idx/waiting/");
    const live: string[] = [];
    for (const key of keys) {
      const id = key.slice("idx/waiting/".length);
      const row = await this.store.get(`deferral/${id}`);
      if (
        (row?.value as { status?: string } | undefined)?.status === "waiting"
      ) {
        live.push(id);
      }
    }
    return live;
  }
}

export function deferral(): Plugin {
  let api: Deferrals | undefined;
  return {
    id: "routecraft.deferral",
    dependsOn: ["routecraft.stores"],

    apply(ctx) {
      api = new Deferrals(ctx.require(STORE_API).open("deferral"));
      const deferrals = api;

      ctx.provide(DEFERRAL_API, deferrals);

      ctx.contribute({
        kind: "step",
        name: "defer",
        factory: (...args) => {
          const reason = String(args[0] ?? "unspecified");
          return {
            label: "defer",
            run: async (ex) => void (await deferrals.defer(ex, reason)),
          } satisfies Step;
        },
      });

      ctx.contribute({
        kind: "wrapper",
        id: "routecraft.admission",
        after: ["routecraft.authorize"],
        before: ["routecraft.retry"],
        wrap: (next) => next,
      });

      ctx.contribute({
        kind: "handler",
        id: "routecraft.deferral.recovery",
        point: "error",
        handle: async (ex) =>
          void (await deferrals.defer(ex, "error-recovery")),
      });

      ctx.contribute({
        kind: "exchange",
        id: "routecraft.deferral.affordance",
        factory: {
          token: DEFERRAL_EXT,
          create: (exchange) => ({
            defer: (reason) => deferrals.defer(exchange, reason),
          }),
        },
      });
    },

    health: () => ({ up: api !== undefined }),
  };
}
