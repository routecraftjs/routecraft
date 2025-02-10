import { log, routes, simple, logger } from "routecraft";

export default routes()
  .from([{ id: "hello-world" }, simple("Hello, World!")])
  .tap(log())
  .transform((body) => {
    logger.info("Transforming exchange", { body });
    return body.toUpperCase();
  })
  .to(log())
  .build();
