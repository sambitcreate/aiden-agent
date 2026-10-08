// Adapted from t3code packages/client-runtime/src/device/model.ts @ a6ec88f7 (MIT).
// No three.js import: the viewer component resolves sources without loading the 3D chunk.

/** T3's bundled device models (`renderer/assets/devices/models/`, provenance in `sources.json`). */
export type DeviceAssetModelId = "iphone-18-pro" | "iphone-18-pro-max" | "ipad-pro-13-m5" | "iphone-duo";

export interface DeviceModelSource {
  readonly id: DeviceAssetModelId;
  readonly url: string;
}

export interface DeviceAccessorySource {
  readonly id: "ipad-pro-13-m5-magic-keyboard";
  readonly modelId: "ipad-pro-13-m5";
  readonly url: string;
}

export type DeviceAssetSource = DeviceModelSource | DeviceAccessorySource;

/** Match actual hardware; never stretch an available model to impersonate another device. */
export function resolveDeviceAssetModelId(platform: string, name: string): DeviceAssetModelId | null {
  if (platform !== "ios") return null;
  if (/^iPhone Duo$/iu.test(name)) return "iphone-duo";
  if (/^iPhone 18 Pro Max$/iu.test(name)) return "iphone-18-pro-max";
  if (/^iPhone 18 Pro$/iu.test(name)) return "iphone-18-pro";
  if (/^iPad Pro 13-inch \(M5\)$/iu.test(name)) return "ipad-pro-13-m5";
  return null;
}

/** Only the 13-inch iPad Pro (M5) model has an accessory: its Magic Keyboard. */
export function deviceHasKeyboardAccessory(id: DeviceAssetModelId | null): boolean {
  return id === "ipad-pro-13-m5";
}

/** Each request owns its result. A cancelled or superseded parse must still release its resources. */
export function createDeviceModelSlot<T extends { dispose: () => void }, Source extends DeviceAssetSource = DeviceModelSource>(
  options: {
    load: (source: Source, signal: AbortSignal) => Promise<T>;
    install: (model: T | null) => void;
    onError?: ((cause: unknown) => void) | undefined;
  },
) {
  let request: { source: Source; controller: AbortController } | null = null;
  let current: T | null = null;
  let disposed = false;
  const clear = () => {
    if (current) options.install(null);
    current?.dispose();
    current = null;
  };
  return {
    set(source: Source | null) {
      if (disposed) return;
      if (source?.id === request?.source.id && source?.url === request?.source.url) return;
      request?.controller.abort();
      request = null;
      clear();
      if (!source) return;
      const next = { source, controller: new AbortController() };
      request = next;
      void options.load(source, next.controller.signal).then(
        (model) => {
          if (disposed || request !== next) {
            model.dispose();
            return;
          }
          try {
            options.install(model);
            current = model;
          } catch (cause) {
            options.install(null);
            model.dispose();
            request = null;
            options.onError?.(cause);
          }
        },
        (cause: unknown) => {
          if (!disposed && request === next) {
            request = null;
            options.onError?.(cause);
          }
          // The procedural body stays installed on download, decoding or validation failure.
        },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      request?.controller.abort();
      request = null;
      clear();
    },
  };
}
