import { craft, direct, noop, only, log, simple } from "@routecraft/routecraft";
import { readFile } from "node:fs/promises";

// The shape of every object in the JSON file on disk. This is the type we
// cast the parsed array to so the rest of the pipeline is type-safe.
export interface Product {
  id: string;
  name: string;
  price: number;
  inStock: boolean;
}

// The criteria the reusable route is called with: which product to find.
export interface FindProduct {
  id: string;
}

// Resolve the data file relative to THIS module, not the process cwd. Because
// the source (examples/src) and the bundled output (examples/dist) both sit
// one level under examples/, "../data/products.json" resolves to the same file
// whether the route runs from source (tests) or from dist (the craft CLI).
const CATALOGUE_URL = new URL("../data/products.json", import.meta.url);

// "find-product": a reusable service. It is triggered as a direct() endpoint so
// any other route (or external caller via client.send) can dispatch into it.
// When called, it reads the product catalogue from disk, casts it to the typed
// array, and returns the single product whose id matches the criteria.
const findProductRoute = craft()
  .id("find-product")
  .title("Find product by id")
  .description(
    "Read the product catalogue from disk and return one product by id",
  )
  .from<FindProduct>(direct())
  // Read + parse + cast the file to Product[], merged onto the body under
  // `catalogue`. The `as Product[]` cast is the single point where the untyped
  // JSON becomes typed; only(value => value, "catalogue") tells .enrich() to
  // place it at body.catalogue, so the builder infers the new body shape as
  // FindProduct & { catalogue: Product[] }.
  .enrich(
    async () => JSON.parse(await readFile(CATALOGUE_URL, "utf-8")) as Product[],
    only((catalogue: Product[]) => catalogue, "catalogue"),
  )
  // One body in, one body out. A transform is the right tool here: the body is
  // a single value we map to another single value (the matched product). Were
  // the body an array we wanted to fan out over, we would .split() instead.
  .transform((body) => body.catalogue.find((p) => p.id === body.id) ?? null)
  .to(noop());

// A tiny caller so the example also runs standalone via the craft CLI. It
// dispatches a fixed criteria into the reusable route and logs the matched
// product. Any route (or an external client.send) can call find-product the
// same way, which is why find-product is triggered by direct().
const lookupRoute = craft()
  .id("lookup")
  .from(simple<FindProduct>({ id: "GIZMO-C" }))
  .to(direct<FindProduct>("find-product"))
  .to(log());

export default [findProductRoute, lookupRoute];
