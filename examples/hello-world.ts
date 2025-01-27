import { type DefaultExchange, type Exchange } from "@routecraft/core";
import { log, routes, simple } from "@routecraft/dsl";

export default routes()
  .from({ id: "hello-world" }, simple(() => "Hello, World!"))
  .to(log())
  .process({
    process: (exchange: Exchange<string>) => {
      const { context: _, ...logExchange } = exchange as DefaultExchange;
      console.log("Processing exchange", logExchange);
      return {
        ...exchange,
        body: exchange.body?.toUpperCase(),
      };
    },
  })
  .to(log())
  .build();
