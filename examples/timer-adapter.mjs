import { log, routes, timer } from "routecraft";

export default routes()
  .from([{ id: "timer-adapter" }, timer({ intervalMs: 50, repeatCount: 10 })])
  .to(log())
  .build();
