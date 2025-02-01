import { log, routes, timer } from "@routecraft/dsl";

export default routes()
  .from(timer({ interval: 5000 }))
  .to(log())
  .build();
