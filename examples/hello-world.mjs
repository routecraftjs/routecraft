import { log, routes, simple, processor, logger } from "routecraft";

export default routes()
  .from([{ id: "hello-world" }, simple("Hello, World!")])
  .to(log())
  .process(
    processor((exchange) => {
      const { id, body, headers } = exchange;
      logger.log("Processing exchange", { id, body, headers });
      return {
        ...exchange,
        body: exchange.body?.toUpperCase(),
      };
    }),
  )
  .to(log())
  .build();
