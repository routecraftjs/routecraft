import { log, craft, simple } from "@routecraft/routecraft";

export default craft()
  .id("enrich-example")
  .from(simple({ original: "Original message" }))
  .enrich(() => ({
    additional: "Additional data",
  }))
  .to(log());
