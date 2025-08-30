import { log, craft, timer } from "@routecraftjs/routecraft";

export default craft()
  .from([{ id: "timer-adapter" }, timer({ intervalMs: 50, repeatCount: 10 })])
  .to(log());
