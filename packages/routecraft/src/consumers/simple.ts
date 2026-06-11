import { CraftContext } from "../context.ts";
import { type RouteDefinition } from "../route.ts";
import {
  type ProcessingQueue,
  type Message,
  type Consumer,
  type ConsumerDeps,
} from "../types.ts";
import { type Exchange } from "../exchange.ts";

export class SimpleConsumer implements Consumer<undefined> {
  public readonly context: CraftContext;
  public readonly definition: RouteDefinition;
  public readonly channel: ProcessingQueue<Message>;
  public readonly options: undefined;

  constructor(deps: ConsumerDeps) {
    this.context = deps.context;
    this.definition = deps.definition;
    this.channel = deps.channel;
    this.options = undefined;
  }

  register(handler: (envelope: Message) => Promise<Exchange>): void {
    this.channel.setHandler(handler);
  }
}
