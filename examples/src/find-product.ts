import {
  craft,
  direct,
  noop,
  only,
  log,
  simple,
  json,
} from "@routecraft/routecraft";
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
  // Read the raw file text and keep it alongside the criteria under `raw`.
  // There is no mid-route file-READ adapter (file()/json({path}) are .from()
  // sources, i.e. route triggers), so the byte read itself is node fs.
  .enrich(
    () => readFile(CATALOGUE_URL, "utf-8"),
    only((raw: string) => raw, "raw"),
  )
  // Parse + cast the raw text with the json() adapter (transformer mode):
  // `from` plucks the JSON string out of the body, `getValue` is the single
  // typed cast point, and `to` places the result under `catalogue` while
  // keeping the criteria id.
  .transform(
    json({
      from: (body: FindProduct & { raw: string }) => body.raw,
      getValue: (parsed): Product[] => parsed as Product[],
      to: (body, catalogue) => ({ id: body.id, catalogue }),
    }),
  )
  // One body in, one body out. A transform is the right tool: the body is a
  // single value mapped to another single value (the matched product). Were the
  // body an array we wanted to fan out over, we would .split() instead.
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
