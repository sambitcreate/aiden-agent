import { app, BrowserWindow, dialog, ipcMain, logger, registerNativeHandlers, shell } from "./platform.js";
import { Menu, nativeImage, nativeTheme } from "electron";
import path from "node:path";

import { registerHandlers } from "./handlers/index.js";
import { terminalService } from "./services/terminal.js";
import { getPreloadPath, getWindowUrl } from "./windows/window-paths.js";
import {
  initShortcut,
  initDictationShortcut,
  applyShortcutFromSettings,
  disposeShortcut,
} from "./services/shortcut.js";
import { mcpManager } from "./services/mcp.js";
import {
  disposeFoundationModelsConnection,
  foundationModelsConnection,
} from "./services/foundation-models-connection.js";
import { configStore } from "./services/config-store.js";
import { normalizeAppearanceConfig, type DockIconPreference } from "../renderer/shared/appearance.js";
import { shutdownProviderAuthFlow } from "./services/provider-auth-flow.js";

app.setName("Aiden Agent");
const ownsSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
let closeGuard = { dirty: false, gitBusy: false, path: undefined as string | undefined, saving: false };
let protectedAction: "close" | "quit" | "reload" | null = null;
let forceAppQuit = false;
let cleanupStarted = false;
let lifecycleCheckInFlight = false;
let shutdownStarted = false;

function hasCloseGuard(): boolean {
  return closeGuard.dirty || closeGuard.gitBusy || closeGuard.saving;
}

function confirmProtectedAction(window: BrowserWindow, action: "close" | "reload"): boolean {
  if (closeGuard.gitBusy) {
    dialog.showMessageBoxSync(window, {
      type: "info",
      title: "Git operation in progress",
      message: `Wait for the current Git operation to finish before ${action === "close" ? "closing Aiden" : "reloading"}.`,
      buttons: ["Keep Aiden Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return false;
  }
  if (closeGuard.saving) {
    dialog.showMessageBoxSync(window, {
      type: "info",
      title: "File save in progress",
      message: `Wait for the open file to finish saving before ${action === "close" ? "closing Aiden" : "reloading"}.`,
      buttons: ["Keep Aiden Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return false;
  }
  if (!closeGuard.dirty) return true;
  const response = dialog.showMessageBoxSync(window, {
    type: "warning",
    title: "Discard unsaved edits?",
    message: closeGuard.path
      ? `“${closeGuard.path}” has edits that have not been saved.`
      : "The open file has edits that have not been saved.",
    detail: action === "close"
      ? "Closing Aiden will permanently discard those edits."
      : "Reloading Aiden will permanently discard those edits.",
    buttons: ["Keep Editing", action === "close" ? "Discard Edits and Close" : "Discard Edits and Reload"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

function cleanupApplication(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  disposeShortcut();
  disposeFoundationModelsConnection();
  void mcpManager.closeAll();
}

async function shutdownAndQuit(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  cleanupApplication();
  try {
    await shutdownProviderAuthFlow();
  } catch (error) {
    logger.error("main", "Provider authentication shutdown did not complete cleanly.", error);
  }
  forceAppQuit = true;
  app.quit();
}

async function refreshCloseGuardFromRenderer(window: BrowserWindow): Promise<number | null> {
  try {
    const latest = await window.webContents.executeJavaScript(
      `({
        dirty: document.documentElement.dataset.aidenDirty === "1",
        gitBusy: document.documentElement.dataset.aidenGitBusy === "1",
        revision: Number(document.documentElement.dataset.aidenGuardRevision || "0"),
        saving: document.documentElement.dataset.aidenSaving === "1"
      })`,
      true,
    ) as { dirty?: unknown; gitBusy?: unknown; revision?: unknown; saving?: unknown };
    closeGuard = {
      dirty: latest?.dirty === true,
      gitBusy: latest?.gitBusy === true,
      path: closeGuard.path,
      saving: latest?.saving === true,
    };
    return Number.isSafeInteger(latest?.revision) && Number(latest.revision) >= 0
      ? Number(latest.revision)
      : 0;
  } catch (error) {
    logger.warn("main", "Could not confirm the renderer close guard", error);
    if (!window.isDestroyed()) {
      dialog.showMessageBoxSync(window, {
        type: "info",
        title: "Aiden is still checking this window",
        message: "Aiden could not confirm whether an editor or Git operation is still active. Keep the window open and try again.",
        buttons: ["Keep Aiden Open"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    }
    return null;
  }
}

async function armRendererUnload(window: BrowserWindow, revision: number): Promise<boolean> {
  try {
    return await window.webContents.executeJavaScript(
      `(() => {
        const root = document.documentElement;
        if (Number(root.dataset.aidenGuardRevision || "0") !== ${revision}) return false;
        root.dataset.aidenApprovedGuardRevision = String(${revision});
        return true;
      })()`,
      true,
    ) === true;
  } catch (error) {
    logger.warn("main", "Could not arm the renderer unload guard", error);
    return false;
  }
}

async function authorizeProtectedAction(
  window: BrowserWindow,
  action: "close" | "reload",
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = await refreshCloseGuardFromRenderer(window);
    if (revision === null) return false;
    if (hasCloseGuard() && !confirmProtectedAction(window, action)) return false;
    if (await armRendererUnload(window, revision)) return true;
  }
  if (!window.isDestroyed()) {
    dialog.showMessageBoxSync(window, {
      type: "info",
      title: "Aiden is still updating this window",
      message: "The editor or Git state changed while Aiden prepared this action. Keep the window open and try again.",
      buttons: ["Keep Aiden Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  }
  return false;
}

async function requestWindowClose(window: BrowserWindow): Promise<void> {
  if (lifecycleCheckInFlight || window.isDestroyed()) return;
  lifecycleCheckInFlight = true;
  try {
    if (!await authorizeProtectedAction(window, "close")) return;
    protectedAction = "close";
    window.close();
  } finally {
    lifecycleCheckInFlight = false;
  }
}

async function requestWindowReload(
  window: BrowserWindow,
  options: { ignoreCache?: boolean } = {},
): Promise<void> {
  if (lifecycleCheckInFlight || window.isDestroyed()) return;
  lifecycleCheckInFlight = true;
  try {
    if (!await authorizeProtectedAction(window, "reload")) return;
    closeGuard = { dirty: false, gitBusy: false, path: undefined, saving: false };
    protectedAction = "reload";
    if (options.ignoreCache) window.webContents.reloadIgnoringCache();
    else window.webContents.reload();
  } finally {
    lifecycleCheckInFlight = false;
  }
}

async function requestApplicationQuit(window: BrowserWindow): Promise<void> {
  if (lifecycleCheckInFlight || window.isDestroyed()) return;
  lifecycleCheckInFlight = true;
  try {
    if (!await authorizeProtectedAction(window, "close")) return;
    protectedAction = "quit";
    await shutdownAndQuit();
  } finally {
    lifecycleCheckInFlight = false;
  }
}

ipcMain.handle("app:setCloseGuard", (event, value: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return false;
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  closeGuard = {
    dirty: input.dirty === true,
    gitBusy: input.gitBusy === true,
    path: typeof input.path === "string" && input.path.length <= 4_096 ? input.path : undefined,
    saving: input.saving === true,
  };
  return true;
});

async function applyDockIconPreference(preference: DockIconPreference): Promise<boolean> {
  if (process.platform !== "darwin" || !app.dock) return false;
  const iconPath = preference === "monochrome"
    ? app.isPackaged
      ? path.join(process.resourcesPath, "app-icon-monochrome.png")
      : path.join(app.getAppPath(), "resources", "app-icon-monochrome.png")
    : app.isPackaged
      ? path.join(process.resourcesPath, "app-icon.png")
      : path.join(app.getAppPath(), "resources", "app-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error(`Dock icon is unavailable: ${path.basename(iconPath)}`);
  app.dock.setIcon(icon);
  await app.dock.show();
  return true;
}

async function restoreDockIconPreference(preference: DockIconPreference): Promise<void> {
  try {
    await applyDockIconPreference(preference);
  } catch (error) {
    logger.warn("main", "Could not restore the saved Dock icon", error);
    if (preference === "aiden") return;
    try {
      await applyDockIconPreference("aiden");
    } catch (fallbackError) {
      logger.warn("main", "Could not restore the default Dock icon", fallbackError);
    }
  }
}

ipcMain.handle("app:setDockIcon", async (event, value: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return false;
  if (value !== "aiden" && value !== "monochrome") throw new Error("Invalid Dock icon preference.");
  return applyDockIconPreference(value);
});

function openExternalUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      void shell.openExternal(url.toString());
    }
  } catch {
    logger.warn("main", "Blocked invalid external URL", { value });
  }
}

async function createMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 390,
    minHeight: 456,
    title: "Aiden Agent",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#00000000",
    transparent: true,
    vibrancy: "sidebar",
    visualEffectState: "active",
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const createdWindow = mainWindow;
  const createdWebContentsId = createdWindow.webContents.id;
  createdWindow.once("ready-to-show", () => createdWindow.show());
  createdWindow.on("close", (event) => {
    if (protectedAction === "close" || protectedAction === "quit") return;
    event.preventDefault();
    void requestWindowClose(createdWindow);
  });
  createdWindow.on("closed", () => {
    terminalService.closeForWebContents(createdWebContentsId);
    mainWindow = null;
    closeGuard = { dirty: false, gitBusy: false, path: undefined, saving: false };
    protectedAction = null;
  });

  createdWindow.webContents.on("will-prevent-unload", () => {
    // Never override a newer renderer veto. The approved lifecycle action is
    // retried against a fresh guard revision instead.
    const interruptedAction = protectedAction;
    protectedAction = null;
    if (interruptedAction === "quit") {
      forceAppQuit = false;
      shutdownStarted = false;
      setImmediate(() => void requestApplicationQuit(createdWindow));
    } else if (interruptedAction === "close") {
      setImmediate(() => void requestWindowClose(createdWindow));
    } else {
      setImmediate(() => void requestWindowReload(createdWindow));
    }
  });
  createdWindow.webContents.on("did-finish-load", () => {
    protectedAction = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url === current) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  mainWindow.webContents.on("will-redirect", (event, url) => {
    event.preventDefault();
    openExternalUrl(url);
  });

  const url = getWindowUrl("main-window.html");
  logger.info("main", "Loading renderer", { url });
  await mainWindow.loadURL(url);

  if (process.env.AIDEN_OPEN_DEVTOOLS === "1")
    mainWindow.webContents.openDevTools({ mode: "detach" });
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    void createMainWindow();
  }
}

function setupApplicationMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "Aiden Agent",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Command+,",
          click: () => ipcMain.broadcast("app:navigate", { path: "/settings" }),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Open Workspace in Preferred Editor",
          accelerator: "Command+O",
          click: () => ipcMain.broadcast("app:open-workspace-preferred-editor", {}),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "Command+R",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) void requestWindowReload(mainWindow);
          },
        },
        {
          label: "Force Reload",
          accelerator: "Command+Shift+R",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              void requestWindowReload(mainWindow, { ignoreCache: true });
            }
          },
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  registerNativeHandlers();
  registerHandlers();

  app.on("second-instance", () => showMainWindow());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    void foundationModelsConnection.status({ force: true });
    showMainWindow();
  });

  app.on("before-quit", (event) => {
    if (forceAppQuit) return;
    event.preventDefault();
    if (shutdownStarted || lifecycleCheckInFlight) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      void requestApplicationQuit(mainWindow);
    } else {
      void shutdownAndQuit();
    }
  });

  app.on("will-quit", cleanupApplication);

  app
    .whenReady()
    .then(async () => {
      const settings = await configStore.getSettings();
      const appearance = normalizeAppearanceConfig(settings.appearance);
      nativeTheme.themeSource = appearance.mode;
      await restoreDockIconPreference(appearance.dockIcon);
      setupApplicationMenu();

      initShortcut(() => {
        showMainWindow();
        ipcMain.broadcast("app:focus-composer", {});
      });
      initDictationShortcut(() => {
        showMainWindow();
        ipcMain.broadcast("app:dictate-toggle", {});
      });
      void applyShortcutFromSettings();
      void foundationModelsConnection.status();

      await createMainWindow();
    })
    .catch((error: unknown) => {
      logger.error("main", "Failed to start Aiden Agent", error);
      void shutdownAndQuit();
    });
}
