import { direct, log, craft, simple } from "@routecraftjs/routecraft";

export default craft()
  .id("direct-adapter-2")
  .from(direct("my-direct-2"))
  .tap(log())
  .id("direct-adapter-1")
  .from(direct("my-direct-1"))
  .tap(log())
  .transform(() => "Hello, World! 2")
  .to(direct("my-direct-2"))
  .id("simple")
  .from(simple("Hello, World!"))
  .tap(log())
  .to(direct("my-direct-1"));
