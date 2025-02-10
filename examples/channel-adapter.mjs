import { channel, log, routes, simple } from "@routecraftjs/routecraft";

export default routes()
  .from([{ id: "channel-adapter-1" }, channel("my-channel-1")])
  .tap(log())
  .from([{ id: "simple" }, simple("Hello, World!")])
  .tap(log())
  .to(channel("my-channel-1"))
  .to(channel("my-channel-2"))
  .from([{ id: "channel-adapter-2" }, channel("my-channel-2")])
  .tap(log())
  .build();
