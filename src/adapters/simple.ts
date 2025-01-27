import {
  type CraftContext,
  DefaultExchange,
  type Exchange,
} from "@routecraft/core";

export class SimpleSource {
  constructor(private producer: () => unknown | Promise<unknown>) {}

  async subscribe(
    context: CraftContext,
    handler: (exchange: Exchange) => void,
  ): Promise<() => void> {
    const result = await this.producer();

    if (Array.isArray(result)) {
      for (const item of result) {
        await Promise.resolve(
          handler(new DefaultExchange(context, { body: item })),
        );
      }
    } else {
      await Promise.resolve(
        handler(new DefaultExchange(context, { body: result })),
      );
    }

    return () => {};
  }
}
