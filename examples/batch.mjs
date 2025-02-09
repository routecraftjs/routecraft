import { log, routes, timer } from "routecraft";

export default routes()
  .from([
    { id: "batch-2", batch: { time: 500 } },
    timer({ intervalMs: 100, repeatCount: 10 }),
  ])
  .to(log())
  .build();
