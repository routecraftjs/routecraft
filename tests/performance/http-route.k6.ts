// Executed by k6 (k6 run compiles TypeScript natively since v0.57); this
// file runs inside k6's JavaScript runtime, not Node or Bun, so it must
// only import k6 modules.
import http from "k6/http";
import { check } from "k6";
import type { Options } from "k6/options";

// k6 global; declared locally because the root tsconfig does not load
// @types/k6 ambient globals.
declare const __ENV: Record<string, string | undefined>;

export const options: Options = {
  scenarios: {
    steady: {
      executor: "constant-vus",
      vus: Number(__ENV["VUS"] ?? 50),
      duration: __ENV["DURATION"] ?? "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<50"],
  },
};

const baseUrl = __ENV["BASE_URL"] ?? "http://127.0.0.1:4180";

export default function (): void {
  const res = http.post(
    `${baseUrl}/bench`,
    JSON.stringify({ orderId: 1, items: [1, 2, 3] }),
    { headers: { "Content-Type": "application/json" } },
  );
  check(res, { "status is 200": (r) => r.status === 200 });
}
