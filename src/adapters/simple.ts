import {
  type CraftContext,
  DefaultExchange,
  Exchange,
  HeadersKeys,
  type Source,
} from "@routecraft/core";

export class SimpleSource implements Source {
  constructor(private producer: () => unknown | Promise<unknown>) {}

  async subscribe(
    context: CraftContext,
    handler: (exchange: Exchange) => void,
  ): Promise<() => void> {
    const result = await this.producer();

    if (Array.isArray(result)) {
      const lastIndex = result.length - 1;
      for (let i = 0; i < result.length; i++) {
        const headers = i === lastIndex
          ? { [HeadersKeys.FINAL_MESSAGE]: true }
          : {};
        await Promise.resolve(
          handler(new DefaultExchange(context, { body: result[i], headers })),
        );
      }
    } else {
      await Promise.resolve(
        handler(
          new DefaultExchange(context, {
            body: result,
            headers: { [HeadersKeys.FINAL_MESSAGE]: true },
          }),
        ),
      );
    }

    return () => {};
  }
}
