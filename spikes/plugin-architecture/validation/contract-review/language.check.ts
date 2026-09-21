import {
  application,
  operations,
  infrastructure,
  manual,
  allRuns,
  type Handler,
} from "../../src/v2/index.ts";
const app = application([operations]);
// The low-level string escape hatch is accepted by the compiler.
app.route("r").configure({ "ghost.retry": 2, "auth.authorize": ["pay"] });
// @ts-expect-error missing auth removes its DSL method
app.route("r").authorize("pay");
app
  .route("r")
  .from(manual)
  .transform((_, ex) => {
    // @ts-expect-error missing auth removes its facet
    return ex.auth.principal;
  });
const composite = infrastructure({
  id: "vendor.session",
  facets: {
    session: () => ({ identity: { subject: "a" }, conversation: { id: "b" } }),
  },
});
application([operations, composite])
  .route("r")
  .from(manual)
  .transform((_, ex) => {
    const a: string = ex.session.identity.subject;
    const b: string = ex.session.conversation.id;
    return a + b;
  });
// A default-generic Handler loses the point/decision correlation.
const broad: Handler = {
  kind: "handler",
  id: "broad",
  point: "exit",
  survival: allRuns,
  handle: () => ({ kind: "refuse", reason: "no" }),
};
infrastructure({
  id: "broad",
  bind(c) {
    c.contribute(broad);
  },
});
infrastructure({
  id: "direct",
  bind(c) {
    c.contribute({
      kind: "handler",
      id: "h",
      point: "exit",
      survival: allRuns,
      // @ts-expect-error literal point retains refusal policy
      handle: () => ({ kind: "refuse", reason: "no" }),
    });
  },
});
const READ: unique symbol = Symbol("read");
void READ;
declare module "../../src/v2/contracts.ts" {
  interface HandlerPoints {
    "review:typed": { readonly owner: typeof READ; readonly refuse: false };
  }
}
const typed: Handler<"review:typed"> = {
  kind: "handler",
  id: "typed",
  point: "review:typed",
  survival: allRuns,
  // @ts-expect-error custom point type rejects refusal
  handle: () => ({ kind: "refuse", reason: "no" }),
};
void typed;
// A project-bound callback preserves installed methods without a live singleton.
const plugins = [operations, composite] as const;
void plugins;
type ProjectApp = ReturnType<typeof application<typeof plugins>>;
const defineRoutes = (
  factory: (
    app: ProjectApp,
  ) => readonly import("../../src/v2/index.ts").RouteSpec[],
) => factory;
export const routes = defineRoutes((project) => [
  project
    .route("r")
    .from(manual)
    .transform((_, ex) => ex.session.identity.subject)
    .build(),
]);
