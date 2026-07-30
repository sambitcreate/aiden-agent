// Transactional global shortcut manager. The renderer/shared command catalog is
// authoritative for defaults, validation, display, menu accelerators, and IPC.

import { globalShortcut, logger } from "../platform.js";
import { configStore } from "./config-store.js";
import { DataStoreCorruptWriteError } from "./data-store.js";
import { currentRuntimeProfile } from "../runtime-profile.js";
import type { AppSettings } from "./types.js";
import {
  COMMANDS,
  KeybindingValidationError,
  effectiveBindings,
  migrateLegacyKeybindings,
  prettyAccelerator,
  shouldPersistCanonicalKeybindings,
  validateEffectiveBindings,
  type CommandId,
  type GlobalShortcutStatus,
  type KeybindingSnapshot,
} from "../../renderer/shared/keybindings.js";
import {
  reconcileGlobalShortcuts,
  type RegisteredGlobalShortcut,
} from "./shortcut-registration-core.js";
import {
  createShortcutTransactionQueue,
  ShortcutPersistenceRollbackError,
} from "./shortcut-transaction-core.js";

const handlers = new Map<CommandId, () => void>();
let registered = new Map<CommandId, RegisteredGlobalShortcut>();
let lastUnavailable = new Map<CommandId, string>();
let onBindingsChanged: ((settings: AppSettings, acceleratorsEnabled: boolean) => void) | null =
  null;
let recordingSuspended = false;
let lastAppliedSettings: AppSettings | null = null;
const transactions = createShortcutTransactionQueue<AppSettings, KeybindingSnapshot>();

function logRollbackFailure(error: unknown): void {
  if (error instanceof ShortcutPersistenceRollbackError) {
    logger.error("shortcut", "Shortcut persistence and runtime rollback both failed.", error);
  }
}

/** Called once at startup with the callback that focuses the app + composer. */
export function initShortcut(trigger: () => void): void {
  handlers.set("composer.focus", trigger);
}

/** Called once at startup with the callback that toggles on-device dictation. */
export function initDictationShortcut(trigger: () => void): void {
  handlers.set("dictation.toggle", trigger);
}

/** Called once at startup with the callback that opens the in-window Aiden dock. */
export function initAssistantShortcut(trigger: () => void): void {
  handlers.set("assistant.open", trigger);
}

/** Rebuild native menus or other main-process consumers after a successful apply. */
export function initShortcutBindingsChanged(
  listener: (settings: AppSettings, acceleratorsEnabled: boolean) => void,
): void {
  onBindingsChanged = listener;
}

/** Whether the exact requested Aiden accelerator is currently registered. */
export function isAssistantShortcutActive(accelerator?: string): boolean {
  const active = registered.get("assistant.open")?.accelerator;
  return accelerator ? active === accelerator : Boolean(active);
}

function canonicalKeybindings(settings: AppSettings) {
  return migrateLegacyKeybindings(settings.keybindings, settings);
}

function globalStatuses(
  settings: AppSettings,
  bindings = effectiveBindings(settings.keybindings, settings),
): GlobalShortcutStatus[] {
  const globalShortcutsEnabled = currentRuntimeProfile().globalShortcutsEnabled;
  return COMMANDS.filter((definition) => definition.global).map((definition) => {
    const binding = bindings[definition.id];
    if (!binding || !globalShortcutsEnabled) {
      return { commandId: definition.id, binding, state: "disabled" };
    }
    const active = registered.get(definition.id)?.accelerator === binding;
    return {
      commandId: definition.id,
      binding,
      state: active ? "active" : "unavailable",
      ...(!active
        ? {
            message:
              lastUnavailable.get(definition.id) ??
              `${prettyAccelerator(binding)} is not registered.`,
          }
        : {}),
    };
  });
}

export function shortcutSnapshot(settings: AppSettings): KeybindingSnapshot {
  const overrides = canonicalKeybindings(settings);
  const effective = effectiveBindings(overrides);
  return {
    overrides,
    effective,
    global: globalStatuses(settings, effective),
  };
}

async function applyNow(settings: AppSettings): Promise<KeybindingSnapshot> {
  const overrides = canonicalKeybindings(settings);
  const canonicalSettings = { ...settings, keybindings: overrides };
  const bindings = effectiveBindings(overrides);
  validateEffectiveBindings(bindings);

  const desired = COMMANDS.filter((definition) => definition.global).map((definition) => ({
    commandId: definition.id,
    accelerator:
      currentRuntimeProfile().globalShortcutsEnabled &&
      !recordingSuspended &&
      handlers.has(definition.id)
        ? bindings[definition.id]
        : null,
    handler: handlers.get(definition.id) ?? (() => undefined),
  }));

  const result = await reconcileGlobalShortcuts(
    {
      register: async (accelerator, handler) => {
        try {
          const ok = await globalShortcut.register(accelerator, handler);
          if (!ok) {
            logger.warn(
              "shortcut",
              `Could not register "${accelerator}" (it may be in use by another app).`,
            );
          }
          return ok;
        } catch (error) {
          logger.warn(
            "shortcut",
            `Failed to register "${accelerator}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      },
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    registered,
    desired,
  );
  registered = result.registered;
  if (!result.ok && result.failedCommandId) {
    const message = result.rollbackFailed
      ? `${prettyAccelerator(result.failedAccelerator)} could not be registered, and macOS did not restore every previous shortcut.`
      : `${prettyAccelerator(result.failedAccelerator)} is unavailable. Another app may be using it.`;
    lastUnavailable = new Map([[result.failedCommandId, message]]);
    throw new KeybindingValidationError(message, "registration", result.failedCommandId);
  }
  lastUnavailable.clear();
  onBindingsChanged?.(canonicalSettings, !recordingSuspended);
  lastAppliedSettings = canonicalSettings;
  return shortcutSnapshot(canonicalSettings);
}

/**
 * Apply a proposed settings document without persisting it. Calls are
 * serialized so rapid recordings cannot interleave unregister/register work.
 */
export function applyShortcutSettings(settings: AppSettings): Promise<KeybindingSnapshot> {
  return transactions.run(() => applyNow(settings));
}

/** Temporarily release global accelerators while the recorder captures a chord. */
export function setShortcutRecordingSuspended(suspended: boolean): Promise<KeybindingSnapshot> {
  return transactions.run(async () => {
    const previous = recordingSuspended;
    if (previous === suspended && suspended) {
      if (!lastAppliedSettings) {
        throw new Error("Shortcut recorder suspension lost its applied settings.");
      }
      return shortcutSnapshot(lastAppliedSettings);
    }
    // A renderer closing its recorder must leave the process out of capture
    // mode even if the settings store is temporarily unreadable. Every
    // successful apply refreshes this cache, so a suspended recorder always
    // has a known-good document it can restore from.
    if (!suspended) recordingSuspended = false;
    let settings: AppSettings;
    try {
      settings = await configStore.getSettings();
    } catch (error) {
      if (!suspended && lastAppliedSettings) {
        settings = lastAppliedSettings;
      } else {
        recordingSuspended = previous;
        throw error;
      }
    }
    if (suspended) recordingSuspended = true;
    try {
      return await applyNow(settings);
    } catch (error) {
      // A failed resume must not leave the process in a hidden recorder mode:
      // the renderer has already stopped recording. Keep the desired state
      // unsuspended so a retry or any later shortcut mutation attempts to
      // reclaim the global accelerators and reports truthful unavailable state.
      recordingSuspended = suspended ? previous : false;
      if (suspended) {
        await applyNow(settings).catch(() => undefined);
      } else {
        try {
          onBindingsChanged?.({ ...settings, keybindings: canonicalKeybindings(settings) }, true);
        } catch {
          // Preserve the global registration failure.
        }
      }
      throw error;
    }
  });
}

export function transactShortcutSettings<Value>(
  prepare: (previous: AppSettings) => {
    next: AppSettings;
    persist: () => Promise<void>;
    value: Value;
  },
): Promise<{ snapshot: KeybindingSnapshot; value: Value }> {
  return transactions
    .transact({
      read: () => configStore.getSettings(),
      prepare,
      apply: applyNow,
    })
    .then(({ applied, value }) => ({ snapshot: applied, value }))
    .catch((error: unknown) => {
      logRollbackFailure(error);
      throw error;
    });
}

/** (Re)register global commands from the current settings document. */
export async function applyShortcutFromSettings(): Promise<KeybindingSnapshot> {
  try {
    return await transactions.run(async () => {
      const settings = await configStore.getSettings();
      const keybindings = canonicalKeybindings(settings);
      const needsMigration = shouldPersistCanonicalKeybindings(settings.keybindings, keybindings);
      // Semantic V1 repair is durable configuration normalization, not a user
      // shortcut transaction. Persist it even when an unrelated global chord
      // is currently owned by another macOS app and runtime registration fails.
      if (needsMigration) {
        try {
          await configStore.setSettings({ keybindings });
        } catch (error) {
          if (!(error instanceof DataStoreCorruptWriteError)) throw error;
          logger.warn(
            "shortcut",
            "Skipped keybinding persistence because settings.json does not parse.",
          );
        }
      }
      return applyNow({ ...settings, keybindings });
    });
  } catch (error) {
    logRollbackFailure(error);
    throw error;
  }
}

export function disposeShortcut(): void {
  for (const item of registered.values()) {
    try {
      globalShortcut.unregister(item.accelerator);
    } catch {
      // App teardown must continue even when Electron has already disposed.
    }
  }
  registered.clear();
  lastUnavailable.clear();
  recordingSuspended = false;
  lastAppliedSettings = null;
}
