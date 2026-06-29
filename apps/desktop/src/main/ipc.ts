import {
  DESKTOP_IPC_CHANNELS,
  type DesktopIpcChannel,
  type DesktopIpcRequest,
  type DesktopIpcResponse
} from "../shared/ipcTypes";

type MaybePromise<T> = T | Promise<T>;

export type DesktopIpcHandler<TChannel extends DesktopIpcChannel> = (
  input: DesktopIpcRequest<TChannel>
) => MaybePromise<DesktopIpcResponse<TChannel>>;

export type DesktopIpcHandlers = {
  [TChannel in DesktopIpcChannel]: DesktopIpcHandler<TChannel>;
};

export type DesktopIpcHandlerRegistry = Partial<DesktopIpcHandlers> & Record<string, unknown>;

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, input?: unknown) => Promise<unknown>
  ): void;
}

export class IpcContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcContractError";
  }
}

export class IpcNotImplementedError extends Error {
  readonly code = "IPC_NOT_IMPLEMENTED";

  constructor(readonly channel: DesktopIpcChannel) {
    super(`IPC channel is not implemented yet: ${channel}`);
    this.name = "IpcNotImplementedError";
  }
}

function isDesktopIpcChannel(channel: string): channel is DesktopIpcChannel {
  return DESKTOP_IPC_CHANNELS.includes(channel as DesktopIpcChannel);
}

function assertDesktopIpcChannel(channel: string): asserts channel is DesktopIpcChannel {
  if (!isDesktopIpcChannel(channel)) {
    throw new IpcContractError(`Unknown IPC channel: ${channel}`);
  }
}

function getRequiredHandler<TChannel extends DesktopIpcChannel>(
  handlers: DesktopIpcHandlerRegistry,
  channel: TChannel
): DesktopIpcHandler<TChannel> {
  const handler = handlers[channel];
  if (typeof handler !== "function") {
    throw new IpcContractError(`Missing IPC handler for channel: ${channel}`);
  }

  return handler as unknown as DesktopIpcHandler<TChannel>;
}

function validateHandlerRegistry(handlers: DesktopIpcHandlerRegistry): void {
  for (const channel of Object.keys(handlers)) {
    assertDesktopIpcChannel(channel);
  }

  for (const channel of DESKTOP_IPC_CHANNELS) {
    getRequiredHandler(handlers, channel);
  }
}

export function createIpcContract() {
  return {
    channels: [...DESKTOP_IPC_CHANNELS],
    assertKnownChannel: assertDesktopIpcChannel,
    async invoke<TChannel extends DesktopIpcChannel>(
      handlers: DesktopIpcHandlerRegistry,
      channel: TChannel | string,
      input?: unknown
    ): Promise<DesktopIpcResponse<TChannel>> {
      assertDesktopIpcChannel(channel);
      const handler = getRequiredHandler(handlers, channel);
      return handler(input as DesktopIpcRequest<typeof channel>) as unknown as Promise<
        DesktopIpcResponse<TChannel>
      >;
    }
  };
}

export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  handlers: DesktopIpcHandlerRegistry
): void {
  const contract = createIpcContract();
  validateHandlerRegistry(handlers);

  for (const channel of contract.channels) {
    ipcMain.handle(channel, async (_event, input) => contract.invoke(handlers, channel, input));
  }
}

export function createNotImplementedIpcHandlers(): DesktopIpcHandlers {
  return Object.fromEntries(
    DESKTOP_IPC_CHANNELS.map((channel) => [
      channel,
      async () => {
        throw new IpcNotImplementedError(channel);
      }
    ])
  ) as unknown as DesktopIpcHandlers;
}
