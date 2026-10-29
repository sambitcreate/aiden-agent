// Telegram runtime config store: persists polling offset (lastUpdateId)
// and reads pairing/enablement state from Aiden's AppSettings.
//
// allowedUserId and telegramEnabled live in AppSettings (configStore).
// lastUpdateId is runtime state persisted in <userData>/telegram-runtime.json
// via DataStore so a restart resumes polling without re-processing old updates.
//
// Design reference: pi-telegram (https://github.com/llblab/pi-telegram, MIT)
// — offset persisted ONLY after successful handling (monotonic max).

import { DataStore } from "../data-store.js";
import type { AppSettings } from "../types.js";

export interface TelegramRuntimeState {
  /** Monotonically increasing offset for getUpdates. Undefined on first run. */
  lastUpdateId?: number;
}

export interface TelegramConfigSnapshot {
  enabled: boolean;
  hasToken: boolean;
  allowedUserId?: number;
  lastUpdateId?: number;
}

export interface TelegramConfigDeps {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  hasToken(): Promise<boolean>;
  resolveRootDir(): string;
  runtimeFileName?: string;
}

export function createTelegramConfig(deps: TelegramConfigDeps) {
  let store: DataStore<TelegramRuntimeState> | undefined;

  async function getStore(): Promise<DataStore<TelegramRuntimeState>> {
    if (!store) {
      store = new DataStore<TelegramRuntimeState>(
        deps.runtimeFileName ?? "telegram-runtime.json",
        {},
        () => deps.resolveRootDir(),
      );
    }
    return store;
  }

  async function getRuntimeState(): Promise<TelegramRuntimeState> {
    return (await getStore()).load();
  }

  async function saveRuntimeState(state: TelegramRuntimeState): Promise<void> {
    await (await getStore()).save(state);
  }

  /**
   * Persist the polling offset. Uses monotonic max so an older success
   * cannot rewind past a newer one (pi-telegram rule).
   */
  async function persistOffset(updateId: number): Promise<void> {
    const current = await getRuntimeState();
    if (current.lastUpdateId === undefined || updateId > current.lastUpdateId) {
      await saveRuntimeState({ lastUpdateId: updateId });
    }
  }

  async function getOffset(): Promise<number | undefined> {
    return (await getRuntimeState()).lastUpdateId;
  }

  async function clearOffset(): Promise<void> {
    await saveRuntimeState({});
  }

  async function getSettings(): Promise<AppSettings> {
    return deps.getSettings();
  }

  async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return deps.setSettings(patch);
  }

  async function hasToken(): Promise<boolean> {
    return deps.hasToken();
  }

  async function snapshot(): Promise<TelegramConfigSnapshot> {
    const settings = await deps.getSettings();
    return {
      enabled: settings.telegramEnabled ?? false,
      hasToken: await deps.hasToken(),
      allowedUserId: settings.telegramAllowedUserId,
      lastUpdateId: await getOffset(),
    };
  }

  return {
    persistOffset,
    getOffset,
    clearOffset,
    getSettings,
    setSettings,
    hasToken,
    snapshot,
  };
}

export type TelegramConfig = ReturnType<typeof createTelegramConfig>;
