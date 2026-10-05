import type { HostChatCapability } from "./host-chat-adapter";

/**
 * Composer affordances that act on this Mac rather than on the chat's host.
 * A remote chat hides them instead of quietly running them locally.
 */
export interface ComposerSurfaces {
  /**
   * Attach button, file drop and image paste. A remote chat reads the chosen
   * files on this Mac and uploads them to its host, so it needs that grant.
   */
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

const REMOTE_ATTACHING_COMPOSER_SURFACES: ComposerSurfaces = Object.freeze({
  ...REMOTE_COMPOSER_SURFACES,
  attachments: true,
});

/**
 * Only a chat whose host is this Mac gets the composer's local surfaces. A
 * remote chat may attach files when its host stages uploads; its skills come
 * from the host's own catalog, never from this Mac's slash palette.
 */
export function composerSurfacesFor(capabilities: ReadonlySet<HostChatCapability>): ComposerSurfaces {
  if (capabilities.has("localPanels")) return LOCAL_COMPOSER_SURFACES;
  return capabilities.has("attach") ? REMOTE_ATTACHING_COMPOSER_SURFACES : REMOTE_COMPOSER_SURFACES;
}
