import { type Source, type Subscription } from "../../operations/from";

export class SimpleSourceAdapter<T = unknown> implements Source<T> {
  readonly adapterId = "routecraft.adapter.simple";

  constructor(private producer: () => T | Promise<T>) {}

  async subscribe(sub: Subscription<T>): Promise<void> {
    sub.ready();
    sub.context.logger.debug({ adapter: "simple" }, "Producing messages");
    let result;
    try {
      result = await this.producer();
    } catch (error) {
      sub.context.logger.error(
        { adapter: "simple", err: error },
        "Producer failed; aborting",
      );
      sub.complete();
      throw error;
    }

    if (Array.isArray(result)) {
      sub.context.logger.debug(
        { adapter: "simple", messageCount: result.length },
        "Processing array of messages",
      );
      let failCount = 0;
      try {
        await Promise.all(
          result.map((item: T) =>
            sub.emit({ message: item }).catch(() => {
              // Exchange error already logged by the route pipeline.
              failCount++;
            }),
          ),
        );
      } finally {
        if (failCount > 0) {
          sub.context.logger.warn(
            { adapter: "simple", failCount, total: result.length },
            "Some exchanges in batch failed",
          );
        }
        sub.context.logger.debug(
          { adapter: "simple" },
          "Finished processing array of messages",
        );
        sub.complete();
      }
    } else {
      sub.context.logger.debug(
        { adapter: "simple" },
        "Processing single message",
      );
      try {
        await sub.emit({ message: result });
      } catch {
        // Exchange error already logged by the route pipeline.
        // SimpleSource does not re-throw: the route already emitted
        // context:error, and re-throwing would cause a duplicate emission.
      } finally {
        sub.context.logger.debug(
          { adapter: "simple" },
          "Finished processing single message",
        );
        sub.complete();
      }
    }
  }
}
