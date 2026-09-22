import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { appApi, onNotification, shortcutApi } from "./ipc";
import { queryKeys, useShortcuts } from "./queries";
import {
  COMMAND_BY_ID,
  COMMAND_IDS,
  prettyAccelerator,
  type CommandId,
} from "../shared/keybindings";
import {
  commandExecutionAllowed,
  resolveCommandForKeyEvent,
} from "./command-system-core";
import { toast } from "../components/ui";

export type CommandPaletteMode = "root" | "chats" | "models" | "providers" | "settings";
type CommandHandler = () => void | Promise<void>;

interface CommandSystemValue {
  execute: (commandId: CommandId) => boolean;
  canExecute: (commandId: CommandId) => boolean;
  register: (commandId: CommandId, handler: CommandHandler) => () => void;
  palette: {
    open: boolean;
    mode: CommandPaletteMode;
    setOpen: (open: boolean) => void;
    openMode: (mode?: CommandPaletteMode) => void;
  };
  binding: (commandId: CommandId) => string | null;
}

const CommandSystemContext = React.createContext<CommandSystemValue | null>(null);

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select, [contenteditable='true']") ||
      Boolean(target.closest("[contenteditable='true']")))
  );
}

function openDialogState(): { any: boolean; foreign: boolean } {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-slot="dialog-content"][data-state="open"]',
    ),
  );
  return {
    any: dialogs.length > 0,
    foreign: dialogs.some(
      (dialog) => !dialog.hasAttribute("data-command-palette-content"),
    ),
  };
}

export function CommandSystemProvider({
  children,
  applicationModal = false,
}: {
  children: React.ReactNode;
  applicationModal?: boolean;
}) {
  const queryClient = useQueryClient();
  const shortcuts = useShortcuts();
  const handlers = React.useRef(new Map<CommandId, CommandHandler[]>());
  const [handlerRevision, setHandlerRevision] = React.useState(0);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [paletteMode, setPaletteMode] = React.useState<CommandPaletteMode>("root");
  const bindings = React.useMemo(
    () =>
      shortcuts.data?.effective ??
      (Object.fromEntries(COMMAND_IDS.map((id) => [id, null])) as Record<
        CommandId,
        string | null
      >),
    [shortcuts.data?.effective],
  );

  const register = React.useCallback((commandId: CommandId, handler: CommandHandler) => {
    const list = handlers.current.get(commandId) ?? [];
    list.push(handler);
    handlers.current.set(commandId, list);
    setHandlerRevision((current) => current + 1);
    return () => {
      const current = handlers.current.get(commandId);
      if (!current) return;
      const index = current.lastIndexOf(handler);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) handlers.current.delete(commandId);
      setHandlerRevision((revision) => revision + 1);
    };
  }, []);

  const execute = React.useCallback(
    (commandId: CommandId) => {
      const dialog = openDialogState();
      if (
        !commandExecutionAllowed(commandId, {
          applicationModal,
          dialogOpen: dialog.any,
          foreignDialog: dialog.foreign,
          paletteOpen,
        })
      ) {
        return false;
      }
      if (commandId === "commandPalette.toggle") {
        setPaletteMode("root");
        setPaletteOpen((open) => !open);
        return true;
      }
      const list = handlers.current.get(commandId);
      const handler = list?.[list.length - 1];
      if (!handler) return false;
      try {
        const result = handler();
        if (result && typeof result.then === "function") {
          void result.catch((error: unknown) => {
            toast.error(
              error instanceof Error ? error.message : "The command could not be completed.",
            );
          });
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The command could not be completed.",
        );
      }
      return true;
    },
    [applicationModal, paletteOpen],
  );
  const canExecute = React.useCallback(
    (commandId: CommandId) =>
      !applicationModal &&
      (commandId === "commandPalette.toggle" || handlers.current.has(commandId)),
    [applicationModal],
  );

  const openMode = React.useCallback((mode: CommandPaletteMode = "root") => {
    if (applicationModal) return;
    setPaletteMode(mode);
    setPaletteOpen(true);
  }, [applicationModal]);

  React.useLayoutEffect(() => {
    if (applicationModal && paletteOpen) setPaletteOpen(false);
  }, [applicationModal, paletteOpen]);

  React.useEffect(() => {
    const unsubscribe = shortcutApi.onChanged((snapshot) => {
      queryClient.setQueryData(queryKeys.shortcuts, snapshot);
    });
    return unsubscribe;
  }, [queryClient]);

  React.useEffect(() => {
    return onNotification<{ commandId?: unknown }>("app:command", ({ commandId }) => {
      if (typeof commandId === "string" && commandId in COMMAND_BY_ID)
        execute(commandId as CommandId);
    });
  }, [execute]);

  React.useEffect(() => {
    // This effect is deliberately declared after the native-command listener.
    // Main waits for this handshake before delivering queued menu actions.
    void appApi.rendererReady().catch(() => undefined);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const commandId = resolveCommandForKeyEvent(event, bindings, {
        editable: isEditable(target),
        fileEditor: Boolean(target?.closest("[data-command-scope='fileEditor']")),
        terminal: Boolean(target?.closest("[data-command-scope='terminal'], .ghostty-screen")),
        modal:
          applicationModal ||
          Boolean(document.querySelector('[data-slot="dialog-content"][data-state="open"]')),
        paletteOpen,
        composing: event.isComposing || event.key === "Dead",
        repeat: event.repeat,
        defaultPrevented: event.defaultPrevented,
        recording: Boolean(target?.closest("[data-shortcut-recorder='true']")),
      });
      if (!commandId) return;
      if (commandId === "commandPalette.toggle" || handlers.current.has(commandId)) {
        event.preventDefault();
        event.stopPropagation();
        execute(commandId);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [applicationModal, bindings, execute, paletteOpen]);

  const value = React.useMemo<CommandSystemValue>(
    () => ({
      execute,
      canExecute,
      register,
      palette: {
        open: paletteOpen,
        mode: paletteMode,
        setOpen: setPaletteOpen,
        openMode,
      },
      binding: (commandId) => bindings[commandId],
    }),
    [
      bindings,
      canExecute,
      execute,
      handlerRevision,
      openMode,
      paletteMode,
      paletteOpen,
      register,
    ],
  );

  return <CommandSystemContext.Provider value={value}>{children}</CommandSystemContext.Provider>;
}

export function useCommandSystem(): CommandSystemValue {
  const context = React.useContext(CommandSystemContext);
  if (!context) throw new Error("useCommandSystem must be used inside CommandSystemProvider");
  return context;
}

export function useCommandHandler(
  commandId: CommandId,
  handler: CommandHandler,
  enabled = true,
): void {
  const { register } = useCommandSystem();
  const handlerRef = React.useRef(handler);
  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  React.useEffect(() => {
    if (!enabled) return;
    return register(commandId, () => handlerRef.current());
  }, [commandId, enabled, register]);
}

export function useShortcutLabel(commandId: CommandId): string {
  return prettyAccelerator(useShortcutBinding(commandId));
}

export function useShortcutBinding(commandId: CommandId): string | null {
  const { binding } = useCommandSystem();
  return binding(commandId);
}
