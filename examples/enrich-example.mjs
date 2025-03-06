import { log, routes, simple } from "@routecraftjs/routecraft";

export default routes()
  .from([{ id: "enrich-example" }, simple({ original: "Original message" })])
  .enrich(() => ({
    body: { additional: "Additional data" },
    headers: { "enriched-by": "example-enricher" },
  }))
  .to(log())
  .build();
