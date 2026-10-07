import type { ComposerSurfaces } from "../../lib/hosts/composer-surfaces";

/**
 * A Bot chat composer keeps attachments, voice, Stop and busy Steer/Queue.
 * It hides the workspace, Git, and access context bar, and the slash palette
 * (rename, fork, side questions, export). Model and thinking pickers are not
 * passed in Bot mode.
 */
export const BOT_CHAT_COMPOSER_SURFACES: ComposerSurfaces = Object.freeze({
  attachments: true,
  slashCommands: false,
  localContext: false,
});
