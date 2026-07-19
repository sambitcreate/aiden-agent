import { app, BrowserWindow, ipcMain, logger, registerNativeHandlers, shell } from "./platform.js";
import { Menu } from "electron";

import { registerHandlers } from "./handlers/index.js";
import { getPreloadPath, getWindowUrl } from "./windows/window-paths.js";
import { initShortcut, initDictationShortcut, applyShortcutFromSettings, disposeShortcut } from "./services/shortcut.js";
import { mcpManager } from "./services/mcp.js";

app.setName("Aiden Agent");
registerNativeHandlers();
registerHandlers();

let mainWindow: BrowserWindow | null = null;

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

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
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

  if (process.env.AIDEN_OPEN_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });
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
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  disposeShortcut();
  void mcpManager.closeAll();
});

app.whenReady().then(async () => {
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

  await createMainWindow();
}).catch((error: unknown) => {
  logger.error("main", "Failed to start Aiden Agent", error);
  app.quit();
});
