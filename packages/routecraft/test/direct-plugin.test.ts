import { describe, test, expect } from "vitest";
import { ADAPTER_DIRECT_OPTIONS } from "../src/adapters/direct/shared.ts";
import { CraftContext } from "../src/context.ts";

describe("CraftConfig.direct defaults", () => {
  /**
   * @case CraftContext stores direct channelType when config.direct is provided
   * @preconditions CraftConfig includes a direct field with channelType
   * @expectedResult The context store contains the channelType under ADAPTER_DIRECT_OPTIONS
   */
  test("stores channelType in the context store", () => {
    const MockChannel = class {
      constructor(public endpoint: string) {}
      async send() {
        return {} as never;
      }
      async subscribe() {}
      async unsubscribe() {}
    };
    const ctx = new CraftContext({
      direct: { channelType: MockChannel as never },
    });

    const stored = ctx.getStore(ADAPTER_DIRECT_OPTIONS);
    expect(stored).toHaveProperty("channelType", MockChannel);
  });

  /**
   * @case CraftContext does not set store when config.direct is omitted
   * @preconditions CraftConfig does not include a direct field
   * @expectedResult The context store returns undefined for ADAPTER_DIRECT_OPTIONS
   */
  test("does not set store when config.direct is omitted", () => {
    const ctx = new CraftContext({});

    const stored = ctx.getStore(ADAPTER_DIRECT_OPTIONS);
    expect(stored).toBeUndefined();
  });
});
