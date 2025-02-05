import { log, routes, timer } from "routecraft";

export default routes()
  .from({ id: "timer-adapter" }, timer({ intervalMs: 50 }))
  .to(log())
  .build();
