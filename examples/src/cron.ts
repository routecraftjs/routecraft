import { craft, log, timer } from "@routecraft/routecraft";

export default craft()
  .id("cron")
  .from(timer({ intervalMs: 10, jitterMs: 100 }))
  .to(log());
