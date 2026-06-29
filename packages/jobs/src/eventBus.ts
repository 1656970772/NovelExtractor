export interface TypedEvent {
  type: string;
  payload: object;
  createdAt: string;
}

export type EventHandler<TEvent extends TypedEvent> = (event: TEvent) => void | Promise<void>;

export interface EventBus<TEvent extends TypedEvent> {
  subscribe(handler: EventHandler<TEvent>): () => void;
  subscribeTo<TType extends TEvent["type"]>(
    type: TType,
    handler: EventHandler<Extract<TEvent, { type: TType }>>
  ): () => void;
  publish(event: TEvent): Promise<void>;
}

export function createEventBus<TEvent extends TypedEvent>(): EventBus<TEvent> {
  const handlers: EventHandler<TEvent>[] = [];

  return {
    subscribe(handler) {
      handlers.push(handler);

      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      };
    },

    subscribeTo(type, handler) {
      return this.subscribe((event) => {
        if (event.type === type) {
          return handler(event as Extract<TEvent, { type: typeof type }>);
        }

        return undefined;
      });
    },

    async publish(event) {
      for (const handler of [...handlers]) {
        await handler(event);
      }
    }
  };
}
