import path from "node:path";
import { app } from "../../platform.js";
import { StudioAssetGrants } from "./delivery-core.js";
import { StudioAssetStore } from "./store.js";
import { createNativeStudioThumbnailer } from "./thumbnailer-main.js";

/** App-lifetime singletons. The root resolves only when a studio flag initializes the store. */
export const studioAssetStore = new StudioAssetStore({
  root: () => path.join(app.getPath("userData"), "studio-assets"),
  thumbnailer: createNativeStudioThumbnailer(),
});

export const studioAssetGrants = new StudioAssetGrants();
