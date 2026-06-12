import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import capabilityBoundariesRule from "../src/rules/capability-boundaries";

// ESLint's RuleTester registers describe/it blocks dynamically when
// `.run(...)` is called. Bun:test does not allow new test registrations
// from inside a running test() callback, so `.run(...)` must happen at
// module top-level. See .standards/testing.md § 2 for why RuleTester
// files use describe-level JSDoc instead of per-test JSDoc.
(
  RuleTester as unknown as { describe: typeof describe; it: typeof test }
).describe = describe;
(RuleTester as unknown as { describe: typeof describe; it: typeof test }).it =
  test;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

// The rule resolves specifiers against the real filesystem to find the owning
// capability (a folder containing route.ts), so tests point `filename` at a
// real fixture tree. RuleTester lints the `code` string; the fixture files only
// need to exist so capability detection can locate their route.ts.
const fixturesRoot = fileURLToPath(
  new URL("./__fixtures__/capability-boundaries", import.meta.url),
);
const cap = (...segments: string[]): string => join(fixturesRoot, ...segments);

/**
 * @case capability-boundaries rule on the default `capabilities/route.ts` layout: intra-capability, public-surface, bare, and shared imports pass; reaching into another capability's internals is flagged
 * @preconditions A real fixture tree under capabilities/ with domain folders, nested capabilities, a registry index.ts, an app env.ts, and a shared package; imports exercised from inside and outside capabilities, including ESM .js specifiers, type imports, export-from, and a directory (barrel) import
 * @expectedResult Valid partition reports nothing; each invalid case reports exactly one crossCapabilityInternalImport naming the target capability
 */
ruleTester.run("capability-boundaries", capabilityBoundariesRule, {
  valid: [
    // Intra-capability: route.ts -> ./mapper.js (same folder) is unrestricted.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { map } from "./mapper.js";`,
    },
    // Intra-capability from a nested subfolder back up to the capability files.
    {
      filename: cap(
        "apps/agent/capabilities/employees/onboard/__fixtures__/sample.ts",
      ),
      code: `import { map } from "../mapper.js";`,
    },
    // Cross-capability via the public surface (sibling capability route.ts).
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import other from "../offboard/route.js";`,
    },
    // Cross-capability import from another domain's public surface. The rule is
    // import-kind agnostic, so a value import covers the type-import path too.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { Output } from "../../comms/notify/route.js";`,
    },
    // Bare specifiers (framework, shared packages) are always allowed.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { craft } from "@routecraft/routecraft";`,
    },
    // Relative import into a shared package outside the capabilities tree.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { util } from "../../../../packages/shared/index.js";`,
    },
    // The registry imports each capability's public surface; allowed.
    {
      filename: cap("apps/agent/capabilities/index.ts"),
      code: `import onboard from "./employees/onboard/route.js";`,
    },
    // A capability directly under capabilities/ importing a sibling's surface.
    {
      filename: cap("apps/agent/capabilities/standalone/route.ts"),
      code: `import notify from "../comms/notify/route.js";`,
    },
    // Re-export of a sibling capability's public surface (contract types).
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `export { Output } from "../offboard/route.js";`,
    },
    // Importing a node builtin is a bare specifier; allowed.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { join } from "node:path";`,
    },
    // Detection is extension-agnostic: a capability whose on-disk public
    // surface is route.js (an emitted tree) is still recognised, and importing
    // its surface is allowed even though the default publicSurface is route.ts.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import built from "../../built/route.js";`,
    },
  ],
  invalid: [
    // Reaching into a route.js-surfaced capability's internal: detected and flagged.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { internal } from "../../built/internal.js";`,
      errors: [
        {
          messageId: "crossCapabilityInternalImport",
          data: {
            specifier: "../../built/internal.js",
            capability: "built",
            surface: "route.ts",
          },
        },
      ],
    },
    // Reaching into a sibling capability's internal mapper.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { map } from "../offboard/mapper.js";`,
      errors: [
        {
          messageId: "crossCapabilityInternalImport",
          data: {
            specifier: "../offboard/mapper.js",
            capability: "offboard",
            surface: "route.ts",
          },
        },
      ],
    },
    // Reaching into a capability's internal in another domain.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import { send } from "../../comms/notify/lib.js";`,
      errors: [
        {
          messageId: "crossCapabilityInternalImport",
          data: {
            specifier: "../../comms/notify/lib.js",
            capability: "notify",
            surface: "route.ts",
          },
        },
      ],
    },
    // A file outside any capability (app env) reaching into capability internals.
    {
      filename: cap("apps/agent/env.ts"),
      code: `import { map } from "./capabilities/employees/onboard/mapper.js";`,
      errors: [
        {
          messageId: "crossCapabilityInternalImport",
          data: {
            specifier: "./capabilities/employees/onboard/mapper.js",
            capability: "onboard",
            surface: "route.ts",
          },
        },
      ],
    },
    // The registry reaching into an internal instead of the public surface.
    {
      filename: cap("apps/agent/capabilities/index.ts"),
      code: `import { map } from "./employees/onboard/mapper.js";`,
      errors: [
        {
          messageId: "crossCapabilityInternalImport",
          data: {
            specifier: "./employees/onboard/mapper.js",
            capability: "onboard",
            surface: "route.ts",
          },
        },
      ],
    },
    // export * from another capability's internal.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `export * from "../offboard/mapper.js";`,
      errors: [
        {
          messageId: "crossCapabilityInternalImport",
          data: {
            specifier: "../offboard/mapper.js",
            capability: "offboard",
            surface: "route.ts",
          },
        },
      ],
    },
    // Directory (barrel) import of another capability resolves to its index,
    // not its public surface, so it is a boundary violation.
    {
      filename: cap("apps/agent/capabilities/employees/onboard/route.ts"),
      code: `import everything from "../offboard";`,
      errors: [
        {
          messageId: "crossCapabilityInternalImport",
          data: {
            specifier: "../offboard",
            capability: "offboard",
            surface: "route.ts",
          },
        },
      ],
    },
  ],
});

// Custom layout: capabilities root named `modules` and public surface `api.ts`.
const customRoot = fileURLToPath(
  new URL("./__fixtures__/capability-boundaries-custom", import.meta.url),
);
const mod = (...segments: string[]): string => join(customRoot, ...segments);
const customOptions = [{ capabilitiesDir: "modules", publicSurface: "api.ts" }];

/**
 * @case capability-boundaries rule honours the capabilitiesDir and publicSurface options for repos that use a different layout
 * @preconditions A fixture tree under modules/ where api.ts is the public surface; the rule is configured with { capabilitiesDir: "modules", publicSurface: "api.ts" }
 * @expectedResult Importing a sibling module's api.ts passes; importing its internal.ts reports one crossCapabilityInternalImport naming the surface as api.ts
 */
ruleTester.run(
  "capability-boundaries (custom options)",
  capabilityBoundariesRule,
  {
    valid: [
      {
        filename: mod("modules/alpha/api.ts"),
        code: `import beta from "../beta/api.js";`,
        options: customOptions,
      },
      {
        filename: mod("modules/alpha/api.ts"),
        code: `import { internal } from "./internal.js";`,
        options: customOptions,
      },
    ],
    invalid: [
      {
        filename: mod("modules/alpha/api.ts"),
        code: `import { internal } from "../beta/internal.js";`,
        options: customOptions,
        errors: [
          {
            messageId: "crossCapabilityInternalImport",
            data: {
              specifier: "../beta/internal.js",
              capability: "beta",
              surface: "api.ts",
            },
          },
        ],
      },
    ],
  },
);
