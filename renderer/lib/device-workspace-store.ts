/**
 * Window-local device workspace state shared by the Environment tab strip,
 * the device panel, and the floating player: per-chat device tabs (persisted),
 * which device floats over each chat (this window session only), the
 * floating player's size and position, and the auto-float preference.
 */
import * as React from "react";
import {
  EMPTY_CHAT_DEVICE_TABS,
  parseStoredDeviceTabs,
  withChatDeviceTabs,
  type ChatDeviceTabs,
  type StoredDeviceTabs,
} from "./device-tabs";
import {
  parseDeviceMiniPlayerGeometry,
  serializeDeviceMiniPlayerGeometry,
  type DeviceMiniPlayerGeometry,
} from "./device-mini-player-layout";

export const DEVICE_TABS_STORAGE_KEY = "aiden-agent.devices.tabs-v1";
export const DEVICE_MINI_PLAYER_STORAGE_KEY = "aiden-agent.devices.mini-player-v1";
export const DEVICE_AUTO_FLOAT_STORAGE_KEY = "aiden-agent.devices.auto-float";

interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DeviceWorkspaceStore {
  subscribe(listener: () => void): () => void;
  tabs(chatId: string): ChatDeviceTabs;
  updateTabs(chatId: string, update: (tabs: ChatDeviceTabs) => ChatDeviceTabs): void;
  /** The device tab key floating over this chat, if any. */
  floating(chatId: string): string | null;
  setFloating(chatId: string, key: string | null): void;
  geometry(): DeviceMiniPlayerGeometry;
  setGeometry(geometry: DeviceMiniPlayerGeometry): void;
  /** Whether an agent-opened device floats over the chat. On unless the user turned it off. */
  autoFloat(): boolean;
  setAutoFloat(enabled: boolean): void;
}

/** Storage failures (private mode, quota) keep the in-memory state working. */
function safeRead(storage: WorkspaceStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(storage: WorkspaceStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* The state still applies for this window. */
  }
}

export function createDeviceWorkspaceStore(storage: WorkspaceStorage | null): DeviceWorkspaceStore {
  const listeners = new Set<() => void>();
  let stored: StoredDeviceTabs | null = null;
  let geometry: DeviceMiniPlayerGeometry | null = null;
  let autoFloat: boolean | null = null;
  const floating = new Map<string, string>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const tabsState = () => (stored ??= parseStoredDeviceTabs(safeRead(storage, DEVICE_TABS_STORAGE_KEY)));
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tabs: (chatId) => tabsState().chats[chatId] ?? EMPTY_CHAT_DEVICE_TABS,
    updateTabs(chatId, update) {
      const current = tabsState().chats[chatId] ?? EMPTY_CHAT_DEVICE_TABS;
      const next = update(current);
      if (next === current) return;
      stored = withChatDeviceTabs(tabsState(), chatId, next);
      safeWrite(storage, DEVICE_TABS_STORAGE_KEY, JSON.stringify(stored));
      notify();
    },
    floating: (chatId) => floating.get(chatId) ?? null,
    setFloating(chatId, key) {
      if ((floating.get(chatId) ?? null) === key) return;
      if (key) floating.set(chatId, key);
      else floating.delete(chatId);
      notify();
    },
    geometry: () => (geometry ??= parseDeviceMiniPlayerGeometry(safeRead(storage, DEVICE_MINI_PLAYER_STORAGE_KEY))),
    setGeometry(next) {
      const current = geometry;
      if (
        current &&
        current.width === next.width &&
        current.position?.x === next.position?.x &&
        current.position?.y === next.position?.y
      ) {
        return;
      }
      geometry = next;
      safeWrite(storage, DEVICE_MINI_PLAYER_STORAGE_KEY, serializeDeviceMiniPlayerGeometry(next));
      notify();
    },
    autoFloat: () => (autoFloat ??= safeRead(storage, DEVICE_AUTO_FLOAT_STORAGE_KEY) !== "0"),
    setAutoFloat(enabled) {
      if (autoFloat === enabled) return;
      autoFloat = enabled;
      safeWrite(storage, DEVICE_AUTO_FLOAT_STORAGE_KEY, enabled ? "1" : "0");
      notify();
    },
  };
}

function windowStorage(): WorkspaceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export const deviceWorkspace: DeviceWorkspaceStore = createDeviceWorkspaceStore(windowStorage());

export function useChatDeviceTabs(chatId: string | null | undefined): ChatDeviceTabs {
  return React.useSyncExternalStore(
    deviceWorkspace.subscribe,
    () => (chatId ? deviceWorkspace.tabs(chatId) : EMPTY_CHAT_DEVICE_TABS),
    () => EMPTY_CHAT_DEVICE_TABS,
  );
}

export function useFloatingDevice(chatId: string | null | undefined): string | null {
  return React.useSyncExternalStore(
    deviceWorkspace.subscribe,
    () => (chatId ? deviceWorkspace.floating(chatId) : null),
    () => null,
  );
}

export function useDeviceMiniPlayerGeometry(): DeviceMiniPlayerGeometry {
  return React.useSyncExternalStore(deviceWorkspace.subscribe, deviceWorkspace.geometry, deviceWorkspace.geometry);
}

export function useAutoFloatDevice(): boolean {
  return React.useSyncExternalStore(deviceWorkspace.subscribe, deviceWorkspace.autoFloat, () => true);
}
