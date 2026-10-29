import type { MenuItemConstructorOptions } from "electron";
import { COMMAND_IDS, electronAcceleratorForPlatform } from "../../renderer/shared/keybindings.js";

export interface ApplicationMenuActions {
  checkForUpdates(): void;
  deliverCommand(commandId: string): void;
  reload(ignoreCache: boolean): void;
}

/** The command ids the renderer reports it can run now; anything else is dropped. */
export function parseMenuCommandIds(value: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(COMMAND_IDS);
  return new Set(value.filter((id): id is string => typeof id === "string" && known.has(id)));
}

type MenuClickEvent = Partial<
  Record<"triggeredByAccelerator" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>
>;

/**
 * Whether a menu item was fired by its own shortcut rather than chosen. Electron
 * marks every activation that isn't a mouse click as `triggeredByAccelerator`,
 * Return in an open menu included, so the shortcut is told apart by the
 * modifiers held: every shortcut has one, and choosing from a menu needs none.
 */
export function firedByItsKey(
  event: MenuClickEvent | undefined,
  binding: string | null | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!event?.triggeredByAccelerator || !binding) return false;
  const parts = new Set(binding.split("+"));
  const mac = platform === "darwin";
  const held = {
    Command: Boolean(mac ? event.metaKey : event.ctrlKey),
    Control: Boolean(mac ? event.ctrlKey : event.metaKey),
    Alt: Boolean(event.altKey),
    Shift: Boolean(event.shiftKey),
  };
  return (Object.keys(held) as Array<keyof typeof held>).every(
    (modifier) => held[modifier] === parts.has(modifier),
  );
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
  available = null,
}: {
  platform: NodeJS.Platform;
  appName: string;
  bindings: Readonly<Record<string, string | null | undefined>>;
  actions: ApplicationMenuActions;
  /** Commands the renderer can run now; null until it says, when all are enabled. */
  available?: ReadonlySet<string> | null;
}): MenuItemConstructorOptions[] {
  const commandItem = (
    label: string,
    commandId: string,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator: platformMenuAccelerator(bindings[commandId], platform),
    click: () => actions.deliverCommand(commandId),
  });
  // The renderer owns these keys: whether they act depends on focus and on
  // what is open (a text field, the terminal, the browser). So the menu shows
  // the key without taking it. On Linux and Windows the key is not registered.
  // macOS still fires the item for a key the page left alone (or never saw,
  // from inside a frame), so that press is ignored (see `firedByItsKey`).
  const shownItem = (label: string, commandId: string): MenuItemConstructorOptions => ({
    label,
    accelerator: platformMenuAccelerator(bindings[commandId], platform),
    registerAccelerator: false,
    enabled: !available || available.has(commandId),
    click: (_item, _window, event) => {
      if (firedByItsKey(event, bindings[commandId], platform)) return;
      actions.deliverCommand(commandId);
    },
  });
  const fileItems: MenuItemConstructorOptions[] = [
    commandItem("New Chat", "chat.new"),
    commandItem("New Chat in…", "chat.newIn"),
    commandItem("Open Folder…", "workspace.openFolder"),
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
        shownItem("Toggle Sidebar", "sidebar.toggle"),
        shownItem("Toggle Terminal", "terminal.toggle"),
        shownItem("Toggle Environment", "environment.toggle"),
        { type: "separator" },
        shownItem("Focus Sidebar", "focus.sidebar"),
        shownItem("Focus Conversation", "focus.chat"),
        shownItem("Focus Side Panel", "focus.panel"),
        { type: "separator" },
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
    {
      label: "Go",
      submenu: [
        shownItem("Back", "navigate.back"),
        shownItem("Forward", "navigate.forward"),
        { type: "separator" },
        shownItem("Previous Chat", "chat.previous"),
        shownItem("Next Chat", "chat.next"),
        shownItem("Search Chats…", "chat.search"),
        { type: "separator" },
        shownItem("Bots", "bots.open"),
        shownItem("Open a Bot…", "bots.search"),
        shownItem("Scheduled", "scheduled.open"),
        shownItem("Profile", "profile.open"),
      ],
    },
    {
      label: "Chat",
      submenu: [
        shownItem("Change Model…", "model.change"),
        shownItem("Attach Files…", "composer.attach"),
        shownItem("Find in Chat", "chat.find"),
        shownItem("Stop Reply", "chat.stop"),
        { type: "separator" },
        shownItem("Rename…", "chat.rename"),
        shownItem("Duplicate", "chat.duplicate"),
        shownItem("Fork…", "chat.fork"),
        shownItem("Compact", "chat.compact"),
        shownItem("Export", "chat.export"),
        shownItem("Copy Last Reply", "chat.copyLatest"),
        shownItem("Chat Details", "chat.details"),
        shownItem("Change Folder Access", "workspace.access"),
        { type: "separator" },
        shownItem("Delete…", "chat.delete"),
      ],
    },
    { role: "windowMenu" },
  );
  if (platform === "darwin") {
    template.push({
      role: "help",
      submenu: [shownItem("Keyboard Shortcuts", "shortcuts.show")],
    });
  } else {
    template.push({
      label: "Help",
      submenu: [
        shownItem("Keyboard Shortcuts", "shortcuts.show"),
        commandItem("Command Palette…", "commandPalette.toggle"),
        { type: "separator" },
        { role: "about" },
      ],
    });
  }
  return template;
}
