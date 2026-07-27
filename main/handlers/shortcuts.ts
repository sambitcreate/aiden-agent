import { ipcMain, logger } from "../platform.js";
import { configStore } from "../services/config-store.js";
import {
  rendererDocumentOwner,
  type RendererDocumentOwner,
} from "../services/renderer-document-owner.js";
import {
  setShortcutRecordingSuspended,
  shortcutSnapshot,
  transactShortcutSettings,
} from "../services/shortcut.js";
import {
  applyKeybindingMutation,
  isCommandId,
  type KeybindingSnapshot,
  type KeybindingMutation,
} from "../../renderer/shared/keybindings.js";

interface ShortcutRecorderOwner {
  document: RendererDocumentOwner;
  release: () => void;
  unsubscribe: () => void;
  startPromise: Promise<KeybindingSnapshot> | null;
}

let recorderOwner: ShortcutRecorderOwner | null = null;

function clearRecorderOwner(owner: ShortcutRecorderOwner): void {
  if (recorderOwner !== owner) return;
  recorderOwner = null;
  owner.unsubscribe();
}

async function releaseAbandonedRecorder(owner: ShortcutRecorderOwner): Promise<void> {
  if (recorderOwner !== owner) return;
  clearRecorderOwner(owner);
  try {
    const snapshot = await setShortcutRecordingSuspended(false);
    ipcMain.broadcast("shortcut:changed", snapshot);
  } catch (error) {
    logger.warn(
      "shortcut",
      "Could not restore every global shortcut after the recorder document closed.",
      error,
    );
    try {
      ipcMain.broadcast(
        "shortcut:changed",
        shortcutSnapshot(await configStore.getSettings()),
      );
    } catch {
      // The runtime failure above is already logged.
    }
  }
}

function claimRecorder(
  event: Electron.IpcMainInvokeEvent,
): ShortcutRecorderOwner {
  const document = rendererDocumentOwner(
    event,
    () => new Error("Shortcut recording requires the active renderer document."),
  );
  if (recorderOwner) {
    if (recorderOwner.document.documentId !== document.documentId)
      throw new Error("Another renderer document is already recording a shortcut.");
    return recorderOwner;
  }
  let owner!: ShortcutRecorderOwner;
  owner = {
    document,
    release: () => {
      void releaseAbandonedRecorder(owner);
    },
    startPromise: null,
    unsubscribe: () => undefined,
  };
  recorderOwner = owner;
  owner.unsubscribe = document.onInvalidated(owner.release);
  // onInvalidated can fire synchronously when navigation wins the race between
  // validating the IPC event and installing the listener. Do not let the
  // handler subsequently suspend shortcuts for a document that no longer owns
  // the recorder.
  if (document.isDestroyed() || recorderOwner !== owner) {
    owner.unsubscribe();
    if (recorderOwner === owner) recorderOwner = null;
    throw new Error("Shortcut recorder document changed before recording began.");
  }
  return owner;
}

function startRecorder(owner: ShortcutRecorderOwner): Promise<KeybindingSnapshot> {
  if (owner.startPromise) return owner.startPromise;
  const start = setShortcutRecordingSuspended(true);
  owner.startPromise = start;
  void start
    .catch(async () => {
      clearRecorderOwner(owner);
      try {
        ipcMain.broadcast(
          "shortcut:changed",
          shortcutSnapshot(await configStore.getSettings()),
        );
      } catch {
        // Preserve the suspension failure returned to every joined caller.
      }
    })
    .finally(() => {
      if (owner.startPromise === start) owner.startPromise = null;
    });
  return start;
}

function parseMutation(value: unknown): KeybindingMutation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid shortcut update.");
  const input = value as Record<string, unknown>;
  if (!isCommandId(input.commandId)) throw new Error("Unknown command.");
  if (input.reset === true) return { commandId: input.commandId, reset: true };
  if (typeof input.disabled === "boolean")
    return { commandId: input.commandId, disabled: input.disabled };
  if (typeof input.binding === "string")
    return {
      commandId: input.commandId,
      binding: input.binding,
      ...(input.replace === true ? { replace: true } : {}),
    };
  throw new Error("Shortcut update is missing a binding, disabled state, or reset.");
}

export function registerShortcutHandlers(): void {
  ipcMain.handle("shortcut:get", async () => shortcutSnapshot(await configStore.getSettings()));
  ipcMain.handle("shortcut:set-recording", async (event, suspended: unknown) => {
    if (typeof suspended !== "boolean")
      throw new Error("Invalid shortcut recorder state.");
    const document = rendererDocumentOwner(
      event,
      () => new Error("Shortcut recording requires the active renderer document."),
    );
    if (suspended) return startRecorder(claimRecorder(event));
    const owner = recorderOwner;
    if (owner && owner.document.documentId !== document.documentId)
      throw new Error("Only the active shortcut recorder document can end recording.");
    try {
      const snapshot = await setShortcutRecordingSuspended(false);
      if (owner) clearRecorderOwner(owner);
      ipcMain.broadcast("shortcut:changed", snapshot);
      return snapshot;
    } catch (error) {
      if (owner) clearRecorderOwner(owner);
      try {
        ipcMain.broadcast(
          "shortcut:changed",
          shortcutSnapshot(await configStore.getSettings()),
        );
      } catch {
        // Preserve the recorder restoration failure.
      }
      throw error;
    }
  });

  ipcMain.handle("shortcut:set", async (_event, value: unknown) => {
    const mutation = parseMutation(value);
    try {
      const { snapshot } = await transactShortcutSettings((previous) => {
        const keybindings = applyKeybindingMutation(
          previous.keybindings,
          mutation,
          previous,
        );
        return {
          next: { ...previous, keybindings },
          persist: () => configStore.setSettings({ keybindings }).then(() => undefined),
          value: undefined,
        };
      });
      ipcMain.broadcast("shortcut:changed", snapshot);
      return snapshot;
    } catch (error) {
      try {
        ipcMain.broadcast(
          "shortcut:changed",
          shortcutSnapshot(await configStore.getSettings()),
        );
      } catch {
        // Preserve the transaction failure. A subsequent settings retry can
        // refresh status if the settings store itself is unavailable.
      }
      throw error;
    }
  });
}
