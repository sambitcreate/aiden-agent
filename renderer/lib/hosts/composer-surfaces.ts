import type { HostChatCapability } from "./host-chat-adapter";

/**
 * Composer affordances that act on this Mac rather than on the chat's host.
 * A remote chat hides them instead of quietly running them locally.
 */
export interface ComposerSurfaces {
  /** Attach button, file drop and image paste. Remote attachments arrive in a later update. */
  attachments: boolean;
  /** The slash palette: this Mac's skills, commands, `/btw`, compact, clone, fork and export. */
  slashCommands: boolean;
  /** Workspace, Git and pull request context bar plus the workspace access control. */
  localContext: boolean;
}

export const LOCAL_COMPOSER_SURFACES: ComposerSurfaces = Object.freeze({
  attachments: true,
  slashCommands: true,
  localContext: true,
});

const REMOTE_COMPOSER_SURFACES: ComposerSurfaces = Object.freeze({
  attachments: false,
  slashCommands: false,
  localContext: false,
});

/** Only a chat whose host is this Mac gets the composer's local surfaces. */
export function composerSurfacesFor(capabilities: ReadonlySet<HostChatCapability>): ComposerSurfaces {
  return capabilities.has("localPanels") ? LOCAL_COMPOSER_SURFACES : REMOTE_COMPOSER_SURFACES;
}
