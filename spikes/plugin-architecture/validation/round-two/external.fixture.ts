/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
import {
  application,
  operations,
  resilience,
  manual,
  instruction,
  allRuns,
  RETRY,
  TIMEOUT,
  deferral,
  sqlite,
  type Plugin,
  type Family,
  type Cursor,
  type Chain,
  type Phase,
  type Source,
} from "@routecraft/spike-plugin-architecture";
import { strict as assert } from "node:assert";
const CUSTOM: unique symbol = Symbol("outside point");
void CUSTOM;
declare module "@routecraft/spike-plugin-architecture" {
  interface HandlerPoints {
    "acme:inspect": typeof CUSTOM;
  }
}
const DUPLICATE: unique symbol = Symbol("duplicate point");
void DUPLICATE;
declare module "@routecraft/spike-plugin-architecture" {
  interface HandlerPoints {
    // @ts-expect-error independent point owners cannot redeclare the same name with different identities
    "acme:inspect": typeof DUPLICATE;
  }
}
type Choose<B, P extends readonly Plugin[], H extends object> = {
  choose(this: Cursor<B, P, H, "after">): Chain<B, P, H, "after">;
};
interface ChooseFamily extends Family {
  readonly methods: Choose<this["Body"], this["Plugins"], this["Headers"]>;
}
const trace: string[] = [];
const stranger: Plugin<ChooseFamily, { audit: () => { label: string } }> = {
  id: "acme.stranger",
  facets: { audit: () => ({ label: "outside" }) },
  methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
    cursor: Cursor<B, P, H, S>,
  ): Choose<B, P, H> {
    const child = instruction(
      "acme.stranger",
      "external-child",
      async (ex, ctx) => {
        trace.push("branch");
        const decorated = await ctx.invoke("acme:inspect", ex);
        return { kind: "continue", exchange: decorated ?? ex };
      },
    );
    return {
      choose: () =>
        cursor.step(
          "external-branch",
          (ex) => ({ kind: "branch", exchange: ex, steps: [child] }),
          [child],
        ),
    };
  },
  bind(ctx) {
    ctx.contribute({
      kind: "handler",
      id: "external-point",
      point: "acme:inspect",
      survival: allRuns,
      handle(ex) {
        trace.push("point");
        return { kind: "allow", exchange: ex };
      },
    });
    ctx.contribute({
      kind: "wrapper",
      id: "audit",
      after: [{ anchor: RETRY, presence: "required" }],
      before: [{ anchor: TIMEOUT, presence: "required" }],
      survival: allRuns,
      bind: () => async (next, run) => {
        trace.push("wrapper");
        return next(run);
      },
    });
  },
};
const app = application([
  operations,
  resilience,
  stranger,
  deferral,
  sqlite(":memory:", "acme.store", true),
]);
let held = "";
const source: Source<number> = {
  owner: "acme.stranger",
  async subscribe(emit) {
    held = (await emit(5)).deferrals[0] ?? "";
    return () => {
      trace.push("unsubscribe");
    };
  },
};
const spec = app
  .route<{ correlation: string }>("outside")
  .retry(2)
  .from(source)
  .choose()
  .transform((body, ex) => {
    assert.equal(ex.audit.label, "outside");
    assert.equal(typeof ex.deferral.request, "function");
    return body + 1;
  })
  .defer("hold")
  .transform((body) => {
    trace.push(`suffix:${body}`);
    return body;
  })
  .build();
await app.start([spec]);
assert.deepEqual(trace, ["wrapper", "branch", "point"]);
assert.equal((await app.runtime.resume(held)).exchanges[0]?.body, 6);
assert.deepEqual(trace, ["wrapper", "branch", "point", "wrapper", "suffix:6"]);
assert.equal(
  app.runtime.dump().providers.find((p) => p.port === "records.atomic@1")
    ?.plugin,
  "acme.store",
);
await app.stop();
assert.equal(trace.at(-1), "unsubscribe");
// The same package installation can host a second context without these capabilities.
const lean = application([operations]);
await lean.start([]);
await lean.stop();
if (process.env["TYPE_ONLY_PROBE"] === "run") {
  const other = lean.route("lean").from(manual);
  // @ts-expect-error omitted plugin method
  other.choose();
  other.transform((_, ex) => {
    // @ts-expect-error omitted plugin facet
    void ex.audit;
  });
}
console.log(
  "PACKED: external branching DSL, open handler, source, facets, replacement, actual resume PASS",
);
