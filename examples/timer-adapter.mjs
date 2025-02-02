import { log, routes, timer } from "@routecraft/dsl";

export default routes()
  .from(timer({ intervalMs: 5000 }))
  .to(log())
  .build();
