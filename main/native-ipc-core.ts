/**
 * Input checks and notification routing for the native IPC bridge in
 * platform.ts. Kept free of Electron imports so the rules are testable.
 */

export type MediaStatusType = "microphone" | "camera" | "screen";
export type MediaRequestType = "microphone" | "camera";

export function parseMediaStatusType(value: unknown): MediaStatusType {
  if (value === "microphone" || value === "camera" || value === "screen") return value;
  throw new Error("Invalid media type.");
}

/** Screen recording has no ask API; it is granted in System Settings. */
export function parseMediaRequestType(value: unknown): MediaRequestType {
  if (value === "microphone" || value === "camera") return value;
  throw new Error("Invalid media type.");
}

export interface BroadcastReceiver {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/**
 * The windows that asked for renderer notifications, each with the channels
 * it listens to (`null` means every channel). Helper windows that never
 * registered (snapshot, picture-in-picture, recorder, display capture) are
 * never sent payloads they would only discard.
 */
export function createBroadcastReceivers<Key>() {
  const receivers = new Map<Key, { receiver: BroadcastReceiver; channels: ReadonlySet<string> | null }>();

  return {
    register(key: Key, receiver: BroadcastReceiver, channels: ReadonlySet<string> | null = null): void {
      receivers.set(key, { receiver, channels });
    },
    unregister(key: Key): void {
      receivers.delete(key);
    },
    /** Receivers for `channel`, dropping any whose window is already gone. */
    targets(channel: string): BroadcastReceiver[] {
      const targets: BroadcastReceiver[] = [];
      for (const [key, entry] of receivers) {
        if (entry.receiver.isDestroyed()) {
          receivers.delete(key);
          continue;
        }
        if (entry.channels === null || entry.channels.has(channel)) targets.push(entry.receiver);
      }
      return targets;
    },
    /**
     * Sends `payload` to every receiver for `channel`. A window whose send
     * throws (mid-teardown, say) is reported and skipped; the rest still get it.
     */
    deliver(channel: string, payload: unknown, onError: (error: unknown) => void): void {
      for (const receiver of this.targets(channel)) {
        try {
          receiver.send(channel, payload);
        } catch (error) {
          onError(error);
        }
      }
    },
  };
}
