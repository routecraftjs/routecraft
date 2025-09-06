import { log, craft, timer } from "@routecraftjs/routecraft";

export default craft()
  .id("batch-2")
  .batch({ size: 5 })
  .from(timer({ intervalMs: 100, repeatCount: 10 }))
  .tap(log());
