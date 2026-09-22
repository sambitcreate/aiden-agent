import { join } from "node:path";
import { app } from "../platform.js";
import { createNativeBotAvatarNormalizer } from "./bot-avatar-image-main.js";
import { createBotAvatarApplicationAdapter } from "./bot-avatar-application-adapter.js";
import { createFileBotAvatarStore } from "./bot-avatar-store.js";

export const botAvatarStore = createFileBotAvatarStore({
  root: () => join(app.getPath("userData"), "bot-avatar-store"),
  normalizer: createNativeBotAvatarNormalizer(),
});

/** Bind this once the Remote instance registry supplies its stable instance id. */
export function createMainBotAvatarApplicationAdapter(ownerId: string) {
  return createBotAvatarApplicationAdapter({ store: botAvatarStore, ownerId });
}
