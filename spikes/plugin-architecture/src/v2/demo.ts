/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
import {
  application,
  operations,
  resilience,
  deferral,
  sqlite,
  manual,
} from "./index.ts";
const app = application([
  operations,
  resilience,
  deferral,
  sqlite(":memory:", "acme.sqlite", true),
]);
const effects: string[] = [];
const route = app
  .route("approval-demo")
  .retry(2)
  .from(manual)
  .transform(() => {
    effects.push("before");
    return "hello";
  })
  .defer("approve")
  .transform((body) => {
    effects.push("after");
    return `${body} world`;
  })
  .build();
await app.start([route]);
const parked = await app.runtime.deliver("approval-demo", null);
console.log("park", JSON.stringify(parked), "effects", effects);
console.log(
  "resume",
  JSON.stringify(await app.runtime.resume(parked.deferrals[0]!)),
  "effects",
  effects,
);
console.log(
  "resume again",
  JSON.stringify(await app.runtime.resume(parked.deferrals[0]!)),
  "effects",
  effects,
);
console.log("plan", JSON.stringify(app.runtime.dump(), null, 2));
await app.stop();
