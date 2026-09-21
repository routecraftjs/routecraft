/** Strict compiler fixtures: none of these negative controls run as JavaScript. */
import {
  application,
  operations,
  resilience,
  deferral,
  sqlite,
  manual,
  type Source,
  type Plugin,
  type Family,
  type Cursor,
  type Chain,
  type Phase,
  allRuns,
  type Handler,
} from "./index.ts";
type Pair<B, P extends readonly Plugin[], H extends object> = {
  pair(this: Cursor<B, P, H, "after">): Chain<readonly [B, B], P, H, "after">;
};
interface PairFamily extends Family {
  readonly methods: Pair<this["Body"], this["Plugins"], this["Headers"]>;
}
export const pairs: Plugin<PairFamily, Record<never, never>> = {
  id: "acme.pairs",
  facets: {},
  methods: <B, P extends readonly Plugin[], H extends object, S extends Phase>(
    c: Cursor<B, P, H, S>,
  ): Pair<B, P, H> => ({ pair: () => c.map((b) => [b, b] as const) }),
};
const source: Source<{ subject: string }> = manual;
const app = application([
  operations,
  resilience,
  pairs,
  deferral,
  sqlite(":memory:"),
]);
const typed = app
  .route<{ trace: string }>("types")
  .retry(2)
  .from(source)
  .transform((body, ex) => {
    const s: string = body.subject;
    const trace: string | undefined = ex.headers.trace;
    void trace;
    ex.deferral.request("approval");
    // @ts-expect-error headers are explicit, not an ambient global bag
    void ex.headers.missing;
    return Promise.resolve(s);
  })
  .pair()
  .transform((pair) => pair[0].length + pair[1].length)
  .defer("approval");
void typed;
const lean = application([operations]);
const before = lean.route("lean");
// @ts-expect-error pipeline operation requires after-from receiver
before.transform(() => 1);
const after = before.from(source);
// @ts-expect-error route-only operation requires before-from receiver
after.title("late");
// @ts-expect-error omitted plugin removes method
after.defer("no");
after.transform((_, ex) => {
  // @ts-expect-error omitted plugin removes facet
  void ex.deferral;
});
const ghost: Plugin<PairFamily, Record<never, never>> = {
  id: "ghost",
  facets: {},
  // @ts-expect-error installed family must return its implementation
  methods: () => ({}),
};
void ghost;
const union = Math.random() ? pairs : operations;
const uncertain = application([union]).route("union").from(source);
// @ts-expect-error pair is merely possible, not installed with certainty
uncertain.pair();
const dynamic: Plugin[] = [operations];
// @ts-expect-error dynamic lists have no statically known DSL
application(dynamic);
const preserved = lean.route("body").from(manual as Source<string>);
preserved.step(
  "changes-body",
  // @ts-expect-error a body-preserving step cannot return an incompatible body
  (ex) => ({ kind: "continue", exchange: { ...ex, body: 42 } }),
);

// @ts-expect-error declining resilience removes its route and step retry method
lean.route("no-retry").retry(2);

// @ts-expect-error declining auth removes the authorize route method
lean.route("no-auth").authorize("admin");
const cannotRefuseAtExit: Handler<"exit"> = {
  kind: "handler",
  id: "late-refusal",
  point: "exit",
  survival: allRuns,
  // @ts-expect-error a point that does not honour refusal cannot return one
  handle: () => ({ kind: "refuse", reason: "no" }),
};
void cannotRefuseAtExit;
