/* eslint-disable no-console -- Executable spike reports intentionally write validation evidence. */
/** Honest limit probe, excluded from acceptance tests: in-process arbitrary effects cannot be revoked. */
import {
  application,
  infrastructure,
  resilience,
  instruction,
} from "../../src/v2/index.ts";
let release!: () => void;
const gate = new Promise<void>((r) => {
  release = r;
});
let effect = false;
const app = application([resilience, infrastructure({ id: "uncooperative" })]);
await app.start([
  {
    id: "r",
    owner: "uncooperative",
    version: "1",
    tags: [],
    options: { "resilience.timeout": 1 },
    steps: [
      instruction("uncooperative", "raw-io", async (ex) => {
        await gate;
        effect = true;
        return { kind: "continue", exchange: ex };
      }),
    ],
  },
]);
try {
  await app.runtime.deliver("r", 0);
} catch (error) {
  console.log(String(error));
}
release();
await new Promise((r) => setTimeout(r, 5));
console.log(`UNGUARDED_EFFECT_AFTER_TIMEOUT=${effect}`);
await app.stop();
