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

const OPEN_DIALOG_PROPERTIES = new Set([
  "openFile",
  "openDirectory",
  "multiSelections",
  "createDirectory",
  "showHiddenFiles",
] as const);
type OpenDialogProperty = typeof OPEN_DIALOG_PROPERTIES extends Set<infer T> ? T : never;

const MAX_DIALOG_TEXT = 200;
const MAX_DIALOG_FILTERS = 20;
const MAX_FILTER_EXTENSIONS = 50;

export interface RendererOpenDialogOptions {
  title?: string;
  buttonLabel?: string;
  message?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: OpenDialogProperty[];
}

function dialogText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_DIALOG_TEXT) {
    throw new Error(`Invalid open dialog ${field}.`);
  }
  return value;
}

/**
 * Keep only the open-dialog options a renderer may choose. A starting folder
 * (`defaultPath`) and platform-specific flags stay with main-side pickers,
 * which already exist for every flow that needs them.
 */
export function parseOpenDialogOptions(value: unknown): RendererOpenDialogOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid open dialog options.");
  }
  const input = value as Record<string, unknown>;
  const options: RendererOpenDialogOptions = {};
  const title = dialogText(input.title, "title");
  const buttonLabel = dialogText(input.buttonLabel, "button label");
  const message = dialogText(input.message, "message");
  if (title !== undefined) options.title = title;
  if (buttonLabel !== undefined) options.buttonLabel = buttonLabel;
  if (message !== undefined) options.message = message;

  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters) || input.filters.length > MAX_DIALOG_FILTERS) {
      throw new Error("Invalid open dialog filters.");
    }
    options.filters = input.filters.map((filter: unknown) => {
      const entry = filter as { name?: unknown; extensions?: unknown } | null;
      if (
        !entry ||
        typeof entry.name !== "string" ||
        entry.name.length > MAX_DIALOG_TEXT ||
        !Array.isArray(entry.extensions) ||
        entry.extensions.length > MAX_FILTER_EXTENSIONS ||
        !entry.extensions.every(
          (extension) =>
            typeof extension === "string" && /^(?:\*|[A-Za-z0-9][A-Za-z0-9._-]{0,31})$/u.test(extension),
        )
      ) {
        throw new Error("Invalid open dialog filters.");
      }
      return { name: entry.name, extensions: [...(entry.extensions as string[])] };
    });
  }

  if (input.properties !== undefined) {
    if (!Array.isArray(input.properties)) throw new Error("Invalid open dialog properties.");
    const properties = new Set<OpenDialogProperty>();
    for (const property of input.properties) {
      if (!OPEN_DIALOG_PROPERTIES.has(property as OpenDialogProperty)) {
        throw new Error("Invalid open dialog properties.");
      }
      properties.add(property as OpenDialogProperty);
    }
    options.properties = [...properties];
  }
  return options;
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
  };
}
