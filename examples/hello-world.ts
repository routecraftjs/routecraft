import { Exchange } from "@routecraft/core";
import { log, routes, simple } from "@routecraft/dsl";

export default routes()
  .from({ id: "hello-world" }, simple(() => "Hello, World!"))
  .to(log())
  .process({
    process: (exchange: Exchange<string>) => {
      return {
        ...exchange,
        body: exchange.body?.toUpperCase(),
      };
    },
  })
  .to(log())
  .build();
