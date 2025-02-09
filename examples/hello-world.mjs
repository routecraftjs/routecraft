import { log, routes, simple, logger } from "routecraft";

export default routes()
  .from([{ id: "hello-world" }, simple("Hello, World!")])
  .to(log())
  .process((exchange) => {
    const { id, body, headers } = exchange;
    logger.info("Processing exchange", { id, body, headers });
    return {
      ...exchange,
      body: exchange.body?.toUpperCase(),
    };
  })
  .to(log())
  .build();
