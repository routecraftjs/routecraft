import { type Exchange } from "@routecraft/core";
import { log, routes, simple } from "../packages/dsl/mod.ts";

export default routes()
  .from(
    { id: "hello-world" },
    simple(() => "Hello, World!"),
  )
  .to(log())
  .process({
    process: (exchange: Exchange<string>) => {
      const { id, body, headers } = exchange;
      console.info("Processing exchange", { id, body, headers });
      return {
        ...exchange,
        body: exchange.body?.toUpperCase(),
      };
    },
  })
  .to(log())
  .build();
