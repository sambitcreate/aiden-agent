import type { MenuItemConstructorOptions } from "electron";
import { electronAcceleratorForPlatform } from "../../renderer/shared/keybindings.js";

export interface ApplicationMenuActions {
  checkForUpdates(): void;
  deliverCommand(commandId: string): void;
  reload(ignoreCache: boolean): void;
}

export function platformMenuAccelerator(
  binding: string | null | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!binding) return undefined;
  return electronAcceleratorForPlatform(binding, platform);
}

export function applicationMenuTemplate({
  platform,
  appName,
  bindings,
  actions,
}: {
  platform: NodeJS.Platform;
  appName: string;
  bindings: Readonly<Record<string, string | null | undefined>>;
  actions: ApplicationMenuActions;
}): MenuItemConstructorOptions[] {
  const commandItem = (
    label: string,
    commandId: string,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator: platformMenuAccelerator(bindings[commandId], platform),
    click: () => actions.deliverCommand(commandId),
  });
  const fileItems: MenuItemConstructorOptions[] = [
    commandItem("New Chat", "chat.new"),
    commandItem(
      "Open Workspace in Preferred Editor",
      "workspace.openPreferredEditor",
    ),
  ];
  if (platform !== "darwin") {
    fileItems.push(
      { type: "separator" },
      commandItem("Settings…", "settings.open"),
      { type: "separator" },
      { role: "quit" },
    );
  } else {
    fileItems.push({ type: "separator" }, { role: "close" });
  }

  const template: MenuItemConstructorOptions[] = [];
  if (platform === "darwin") {
    template.push({
      label: appName,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: actions.checkForUpdates,
        },
        { type: "separator" },
        commandItem("Command Palette…", "commandPalette.toggle"),
        commandItem("Settings…", "settings.open"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    { label: "File", submenu: fileItems },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => actions.reload(false),
        },
        {
          label: "Force Reload",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => actions.reload(true),
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
  );
  if (platform !== "darwin") {
    template.push({
      label: "Help",
      submenu: [
        commandItem("Command Palette…", "commandPalette.toggle"),
        { type: "separator" },
        { role: "about" },
      ],
    });
  }
  return template;
}
