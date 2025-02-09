import { log, routes, timer, BatchConsumer } from "routecraft";

export default routes()
  .from([
    {
      id: "batch-2",
      consumer: {
        type: BatchConsumer,
        options: {
          size: 5,
        },
      },
    },
    timer({ intervalMs: 100, repeatCount: 10 }),
  ])
  .to(log())
  .build();
