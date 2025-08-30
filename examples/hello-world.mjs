import { log, craft, simple, logger } from "@routecraftjs/routecraft";

export default craft()
  .from([{ id: "hello-world" }, simple("Hello, World!")])
  .tap(log())
  .transform((body) => {
    logger.info("Transforming exchange", { body });
    return body.toUpperCase();
  })
  .to(log());
