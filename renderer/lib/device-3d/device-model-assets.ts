// Adapted from t3code apps/web/src/components/device/deviceModels.ts @ a6ec88f7 (MIT).
//
// T3's device GLBs, bundled as-is (provenance, source URLs and hashes in
// `renderer/assets/devices/models/sources.json`). They are Apple AR assets with
// no established redistribution licence; the owner chose to ship them as T3
// does (2026-10-08). `?url` keeps them out of the JavaScript: each model is a
// separate file fetched only when a matching device is shown in 3D. This module
// is imported lazily by the viewports, never by code that renders on startup.
import iphoneDuo from "../../assets/devices/models/iphone-duo.glb?url";
import iphone18Pro from "../../assets/devices/models/iphone-18-pro.glb?url";
import iphone18ProMax from "../../assets/devices/models/iphone-18-pro-max.glb?url";
import ipadPro13M5 from "../../assets/devices/models/ipad-pro-13-m5.glb?url";
import magicKeyboard from "../../assets/devices/models/ipad-pro-13-m5-magic-keyboard.glb?url";
import type { DeviceAccessorySource, DeviceAssetModelId, DeviceModelSource } from "./model-source";

// Bundled URLs follow the renderer's origin in development and packaged builds.
const MODELS: Readonly<Record<DeviceAssetModelId, DeviceModelSource>> = {
  "iphone-duo": { id: "iphone-duo", url: iphoneDuo },
  "iphone-18-pro": { id: "iphone-18-pro", url: iphone18Pro },
  "iphone-18-pro-max": { id: "iphone-18-pro-max", url: iphone18ProMax },
  "ipad-pro-13-m5": { id: "ipad-pro-13-m5", url: ipadPro13M5 },
};

const KEYBOARD: DeviceAccessorySource = {
  id: "ipad-pro-13-m5-magic-keyboard",
  modelId: "ipad-pro-13-m5",
  url: magicKeyboard,
};

export function deviceModelSource(id: DeviceAssetModelId | null): DeviceModelSource | null {
  return id ? MODELS[id] : null;
}

/** The Magic Keyboard, for the model it belongs to. */
export function deviceKeyboardSource(id: DeviceAssetModelId | null): DeviceAccessorySource | null {
  return id === KEYBOARD.modelId ? KEYBOARD : null;
}
