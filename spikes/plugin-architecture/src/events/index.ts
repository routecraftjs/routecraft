import type {
  EventHandler,
  EventName,
  Registration,
} from "../contracts/index.ts";

/**
 * Observation seam. Stays in core because core emits the lifecycle it
 * manages, and a plugin cannot announce core's own transitions.
 */
export class EventBus {
  readonly #handlers = new Map<EventName, Set<EventHandler>>();

  on(event: EventName, handler: EventHandler): Registration {
    let set = this.#handlers.get(event);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler);
    return { dispose: () => void set.delete(handler) };
  }

  emit(event: EventName, payload: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(payload);
    if (event !== "*") {
      for (const handler of this.#handlers.get("*") ?? []) {
        handler({ event, payload });
      }
    }
  }
}
