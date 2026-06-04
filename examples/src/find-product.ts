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
// When called, it reads the product catalogue from disk, parses and casts it to
// the typed array via the json() adapter, and returns the single product whose
// id matches the criteria.
const findProductRoute = craft()
  .id("find-product")
  .title("Find product by id")
  .description(
    "Read the product catalogue from disk and return one product by id",
  )
  .from<FindProduct>(direct())
  // Read + parse + cast the catalogue, merged onto the body under `catalogue`.
  // There is no mid-route file-READ adapter (file()/json({path}) are .from()
  // sources, i.e. route triggers), and json()'s transformer mode only parses a
  // string you already hold, so wrapping it here adds ceremony with no payoff.
  // The honest minimal is node fs + JSON.parse; the `as Product[]` is the single
  // typed cast point. only(..., "catalogue") tells .enrich() to place the array
  // at body.catalogue, so the builder infers FindProduct & { catalogue: Product[] }.
  .enrich(
    async () => JSON.parse(await readFile(CATALOGUE_URL, "utf-8")) as Product[],
    only((catalogue: Product[]) => catalogue, "catalogue"),
  )
  // Now the body is one value holding both the criteria and the array, so you
  // pick the operation: here a transform (one item out). Were you fanning out
  // over the array you would .split(); to reduce it, .filter()/.aggregate().
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
