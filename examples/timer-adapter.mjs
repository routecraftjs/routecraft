import { log, craft, timer } from "@routecraft/routecraft";

export default craft()
  .id("timer-adapter")
  .from(timer({ intervalMs: 50, repeatCount: 10 }))
  .to(log());
