import {
  craft,
  direct,
  noop,
  only,
  log,
  simple,
  json,
} from "@routecraft/routecraft";
import { fileURLToPath } from "node:url";

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
const CATALOGUE_PATH = fileURLToPath(
  new URL("../data/products.json", import.meta.url),
);

// "find-product": a reusable service. It is triggered as a direct() endpoint so
// any other route (or external caller via client.send) can dispatch into it.
// When called, it reads + parses the product catalogue from disk via the json()
// adapter in read mode, and returns the single product whose id matches.
const findProductRoute = craft()
  .id("find-product")
  .title("Find product by id")
  .description(
    "Read the product catalogue from disk and return one product by id",
  )
  .from<FindProduct>(direct())
  // Read + parse the catalogue mid-route. json({ mode: "read" }) is a
  // destination that returns the parsed file content (like an HTTP GET returns
  // a body), so .enrich() can pull it in. The generic types the parsed value;
  // only(..., "catalogue") places it at body.catalogue, so the builder infers
  // the merged body as FindProduct & { catalogue: Product[] }.
  .enrich(
    json<Product[]>({ path: CATALOGUE_PATH, mode: "read" }),
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
