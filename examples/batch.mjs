import { log, craft, timer, BatchConsumer } from "@routecraftjs/routecraft";

export default craft()
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
  .tap(log());
