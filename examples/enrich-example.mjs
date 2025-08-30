import { log, craft, simple } from "@routecraftjs/routecraft";

export default craft()
  .from([{ id: "enrich-example" }, simple({ original: "Original message" })])
  .enrich(() => ({
    additional: "Additional data",
  }))
  .to(log());
