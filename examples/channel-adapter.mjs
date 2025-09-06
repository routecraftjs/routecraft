import { channel, log, craft, simple } from "@routecraftjs/routecraft";

export default craft()
  .id("channel-adapter-2")
  .from(channel("my-channel-2"))
  .tap(log())
  .id("channel-adapter-1")
  .from(channel("my-channel-1"))
  .tap(log())
  .transform(() => "Hello, World! 2")
  .to(channel("my-channel-2"))
  .id("simple")
  .from(simple("Hello, World!"))
  .tap(log())
  .to(channel("my-channel-1"));
