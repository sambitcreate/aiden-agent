export type AnyInvokeChannel = string;

export type IpcInvokeHandler<TEvent = unknown> = (
  event: TEvent,
  ...args: unknown[]
) => unknown;

export interface IpcCaptureScope<TListener> {
  capture(register: () => void): ReadonlyMap<string, TListener>;
  handle(
    channel: string,
    listener: TListener,
    registerUnderlying: (channel: string, listener: TListener) => void,
  ): void;
}

/**
 * Synchronous handler capture scope used when a lazy IPC registrar runs so its
 * `ipcMain.handle(channel, listener)` calls populate an isolated map instead of
 * re-registering channels that already have startup forwarders installed.
 */
export function createIpcCaptureScope<TListener>(): IpcCaptureScope<TListener> {
  let activeCapture: Map<string, TListener> | null = null;

  return {
    capture(register: () => void): ReadonlyMap<string, TListener> {
      const captured = new Map<string, TListener>();
      const previous = activeCapture;
      activeCapture = captured;
      try {
        register();
      } finally {
        activeCapture = previous;
      }
      return captured;
    },
    handle(
      channel: string,
      listener: TListener,
      registerUnderlying: (channel: string, listener: TListener) => void,
    ): void {
      if (activeCapture) {
        if (activeCapture.has(channel)) {
          throw new Error(`Duplicate IPC handler captured for channel "${channel}".`);
        }
        activeCapture.set(channel, listener);
        return;
      }
      registerUnderlying(channel, listener);
    },
  };
}

export interface LazyIpcGroup<TEvent = unknown> {
  readonly name: string;
  readonly channels: readonly AnyInvokeChannel[];
  readonly isLoaded: () => boolean;
  readonly load: () => Promise<ReadonlyMap<string, IpcInvokeHandler<TEvent>>>;
}

export interface LazyIpcPorts<TEvent = unknown> {
  handle(channel: string, listener: IpcInvokeHandler<TEvent>): void;
  capture(register: () => void): ReadonlyMap<string, IpcInvokeHandler<TEvent>>;
}

export function assertCapturedChannelsMatch<TListener>(
  groupName: string,
  expected: readonly string[],
  captured: ReadonlyMap<string, TListener>,
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((channel) => !captured.has(channel));
  const unexpected = [...captured.keys()].filter((channel) => !expectedSet.has(channel));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      missing.length > 0 ? `missing=[${missing.join(", ")}]` : "",
      unexpected.length > 0 ? `unexpected=[${unexpected.join(", ")}]` : "",
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(`Lazy IPC group "${groupName}" channel mismatch: ${details}`);
  }
}

/**
 * Registers all `channels` synchronously via `ports.handle` while deferring
 * module `import()` evaluation until the first invoke of any channel in the group.
 */
export function createLazyIpcGroup<TEvent = unknown>(
  ports: LazyIpcPorts<TEvent>,
  name: string,
  channels: readonly AnyInvokeChannel[],
  loadRegistrar: () => Promise<() => void>,
): LazyIpcGroup<TEvent> {
  let resolved: ReadonlyMap<string, IpcInvokeHandler<TEvent>> | null = null;
  let inFlight: Promise<ReadonlyMap<string, IpcInvokeHandler<TEvent>>> | null = null;

  const load = (): Promise<ReadonlyMap<string, IpcInvokeHandler<TEvent>>> => {
    if (resolved) return Promise.resolve(resolved);
    if (inFlight) return inFlight;
    const loading = Promise.resolve()
      .then(loadRegistrar)
      .then((register) => {
        if (resolved) return resolved;
        const captured = ports.capture(register);
        assertCapturedChannelsMatch(name, channels, captured);
        resolved = captured;
        return captured;
      })
      .catch((error: unknown) => {
        inFlight = null;
        throw error;
      });
    inFlight = loading;
    return loading;
  };

  for (const channel of channels) {
    ports.handle(channel, async (event: TEvent, ...args: unknown[]) => {
      const handlers = resolved ?? (await load());
      const listener = handlers.get(channel);
      if (!listener) {
        throw new Error(`Lazy IPC group "${name}" has no handler for "${channel}".`);
      }
      return listener(event, ...args);
    });
  }

  return {
    name,
    channels,
    isLoaded: () => resolved !== null,
    load,
  };
}
