import { channel, log, routes, simple } from "routecraft";

export default routes()
  .from({ id: "channel-adapter-1" }, channel("my-channel-1"))
  .to(log())
  .from([{ id: "simple" }, simple("Hello, World!")])
  .to(log())
  .to(channel("my-channel-1"))
  .to(channel("my-channel-2"))
  .from({ id: "channel-adapter-2" }, channel("my-channel-2"))
  .to(log())
  .build();
