import { log, routes, simple } from "@routecraftjs/routecraft";

export default routes()
  .from([{ id: "enrich-example" }, simple({ original: "Original message" })])
  .enrich(() => ({
    additional: "Additional data",
  }))
  .to(log())
  .build();
