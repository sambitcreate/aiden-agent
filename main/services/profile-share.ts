import { BrowserWindow, ShareMenu, dialog, logger, nativeImage } from "../platform.js";
import {
  decodeProfileSharePng,
  MAX_SHARE_IMAGE_BYTES,
  PROFILE_SHARE_HEIGHT,
  PROFILE_SHARE_WIDTH,
} from "./profile-share-core.js";
import {
  cleanupStaleProfileShareDirectories,
  createProfileShareFile,
  PROFILE_SHARE_FILE_NAME,
  removeProfileShareDirectory,
  writeProfileShareExport,
} from "./profile-share-files.js";

const SHARE_FILE_RETENTION_MS = 5 * 60 * 1_000;
const SHARE_SESSION_MAX_AGE_MS = 60 * 60 * 1_000;

interface ShareSession {
  directory: string;
  menu: ShareMenu;
  timer: ReturnType<typeof setTimeout>;
  cleaning: boolean;
}

const activeShareSessions = new Set<ShareSession>();
const ownedShareDirectories = new Set<string>();
let staleCleanupPromise: Promise<void> | null = null;

async function removeShareDirectory(directory: string): Promise<void> {
  try {
    await removeProfileShareDirectory(directory);
  } catch (error) {
    logger.warn("profile-share", "Could not remove temporary share image", error);
  }
}

function beginStaleCleanup(): Promise<void> {
  staleCleanupPromise ??= cleanupStaleProfileShareDirectories({
    activeDirectories: ownedShareDirectories,
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      logger.warn("profile-share", "Could not clean stale temporary share images", error);
    });
  return staleCleanupPromise;
}

function scheduleCleanup(session: ShareSession, delay: number): void {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (session.cleaning) return;
    session.cleaning = true;
    activeShareSessions.delete(session);
    ownedShareDirectories.delete(session.directory);
    void removeShareDirectory(session.directory);
  }, delay);
  session.timer.unref();
}

function canonicalProfileSharePng(dataUrl: unknown): Buffer {
  const input = decodeProfileSharePng(dataUrl);
  const decoded = nativeImage.createFromBuffer(input, { scaleFactor: 1 });
  const size = decoded.getSize(1);
  if (
    decoded.isEmpty() ||
    size.width !== PROFILE_SHARE_WIDTH ||
    size.height !== PROFILE_SHARE_HEIGHT
  ) {
    throw new Error("Aiden couldn't decode the 3:4 profile snapshot.");
  }
  const canonical = decoded.toPNG({ scaleFactor: 1 });
  if (canonical.length === 0 || canonical.length > MAX_SHARE_IMAGE_BYTES) {
    throw new Error("The profile snapshot is empty or too large.");
  }
  return canonical;
}

export async function shareProfilePng(
  dataUrl: unknown,
  parent: BrowserWindow | null,
): Promise<boolean> {
  if (!parent || parent.isDestroyed()) {
    throw new Error("The profile window is no longer available for sharing.");
  }
  const image = canonicalProfileSharePng(dataUrl);
  if (process.platform !== "darwin") {
    const result = await dialog.showSaveDialog(parent, {
      title: "Save profile snapshot",
      defaultPath: PROFILE_SHARE_FILE_NAME,
      buttonLabel: "Save",
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeProfileShareExport(result.filePath, image);
    return true;
  }
  if (activeShareSessions.size > 0) {
    throw new Error("Close the current share menu before opening another one.");
  }

  await beginStaleCleanup();
  const { directory, filePath } = await createProfileShareFile(image);
  ownedShareDirectories.add(directory);
  let session: ShareSession | null = null;

  try {
    const menu = new ShareMenu({ filePaths: [filePath] });
    session = {
      directory,
      menu,
      timer: setTimeout(() => undefined, SHARE_SESSION_MAX_AGE_MS),
      cleaning: false,
    };
    activeShareSessions.add(session);
    scheduleCleanup(session, SHARE_SESSION_MAX_AGE_MS);
    menu.popup({
      window: parent,
      callback: () => {
        if (!session || session.cleaning) return;
        activeShareSessions.delete(session);
        scheduleCleanup(session, SHARE_FILE_RETENTION_MS);
      },
    });
    return true;
  } catch (error) {
    if (session) {
      clearTimeout(session.timer);
      session.cleaning = true;
      activeShareSessions.delete(session);
    }
    ownedShareDirectories.delete(directory);
    await removeShareDirectory(directory);
    throw error;
  }
}
