import { ipcMain } from "../platform.js";
import { configStore } from "../services/config-store.js";
import {
  isAssistantShortcutActive,
  shortcutSnapshot,
  transactShortcutSettings,
} from "../services/shortcut.js";
import {
  applyKeybindingMutation,
  COMMAND_BY_ID,
  effectiveBinding,
  migrateLegacyKeybindings,
} from "../../renderer/shared/keybindings.js";
import type {
  AppSettings,
  AssistantConfig,
  AssistantConfigSnapshot,
} from "../services/types.js";
import { assistantConfigFrom, parseAssistantConfigPatch } from "./assistant-parse.js";

function snapshot(config: AssistantConfig): AssistantConfigSnapshot {
  return {
    config,
    hotkeyActive: isAssistantShortcutActive(),
  };
}

function canonicalAssistantConfig(settings: AppSettings): AssistantConfig {
  const config = assistantConfigFrom(settings);
  const keybindings = migrateLegacyKeybindings(settings.keybindings, settings);
  const override = keybindings.commands["assistant.open"];
  return {
    ...config,
    hotkeyEnabled: effectiveBinding("assistant.open", keybindings) !== null,
    hotkeyAccelerator:
      (typeof override?.binding === "string" ? override.binding : null) ??
      COMMAND_BY_ID["assistant.open"].defaultBinding ??
      config.hotkeyAccelerator,
  };
}

export function registerAssistantHandlers(): void {
  ipcMain.handle("assistant:get-config", async () => {
    const config = canonicalAssistantConfig(await configStore.getSettings());
    return snapshot(config);
  });

  ipcMain.handle("assistant:set-config", async (_event, patch: unknown) => {
    try {
      const { snapshot: shortcutState, value: assistant } =
        await transactShortcutSettings((settings) => {
          const assistant = parseAssistantConfigPatch(
            canonicalAssistantConfig(settings),
            patch,
          );
          // Keep compatibility fields and the canonical command map in
          // lockstep without allowing a stale legacy chord to replace a newer
          // canonical binding.
          let keybindings = migrateLegacyKeybindings(settings.keybindings, settings);
          const patchRecord =
            patch && typeof patch === "object" && !Array.isArray(patch)
              ? patch
              : null;
          const changesAccelerator =
            patchRecord !== null && "hotkeyAccelerator" in patchRecord;
          const changesEnabled =
            patchRecord !== null && "hotkeyEnabled" in patchRecord;
          if (changesAccelerator) {
            keybindings = applyKeybindingMutation(keybindings, {
              commandId: "assistant.open",
              binding: assistant.hotkeyAccelerator,
            });
          }
          if (changesAccelerator || changesEnabled) {
            keybindings = applyKeybindingMutation(keybindings, {
              commandId: "assistant.open",
              disabled: !assistant.hotkeyEnabled,
            });
          }
          return {
            next: { ...settings, assistant, keybindings },
            persist: () =>
              configStore
                .setSettings({ assistant, keybindings })
                .then(() => undefined),
            value: assistant,
          };
        });
      ipcMain.broadcast("shortcut:changed", shortcutState);
      return snapshot(assistant);
    } catch (error) {
      try {
        ipcMain.broadcast(
          "shortcut:changed",
          shortcutSnapshot(await configStore.getSettings()),
        );
      } catch {
        // Preserve the shortcut transaction failure.
      }
      throw error;
    }
  });
}
