/**
 * Per-chat device tabs in the Environment panel: one tab per open device
 * session, renamed per chat, and never resurrected once the user closed it.
 * Pure state only; `device-workspace-store.ts` persists it and the panel and
 * floating player subscribe to it. Adapted from T3 Code's right-panel device
 * surfaces (MIT, see THIRD_PARTY_NOTICES.md).
 */

export interface DeviceTarget {
  hostId: string;
  deviceId: string;
}

export interface ChatDeviceTabs {
  /** Tab keys in strip order. Sessions not listed yet follow in session order. */
  order: string[];
  /** Custom tab names, kept after a tab closes so reopening the device restores it. */
  titles: Record<string, string>;
  /** Tabs the user closed. A session that still exists never brings them back. */
  dismissed: string[];
  /** The selected device tab, or null when the picker is selected. */
  active: string | null;
  /** The device picker tab is open beside the device tabs. */
  picker: boolean;
}

export interface DeviceTab {
  key: string;
  hostId: string;
  deviceId: string;
  /** The custom name, or the device's own name. */
  title: string;
  custom: boolean;
}

export const MAX_DEVICE_TAB_TITLE_LENGTH = 64;
export const MAX_REMEMBERED_DEVICE_CHATS = 50;
const MAX_KEYS_PER_CHAT = 32;

export const EMPTY_CHAT_DEVICE_TABS: ChatDeviceTabs = Object.freeze({
  order: [],
  titles: {},
  dismissed: [],
  active: null,
  picker: false,
}) as ChatDeviceTabs;

export function deviceTabKey(target: DeviceTarget): string {
  return `${encodeURIComponent(target.hostId)}:${encodeURIComponent(target.deviceId)}`;
}

export function parseDeviceTabKey(key: string): DeviceTarget | null {
  const parts = key.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    return { hostId: decodeURIComponent(parts[0]), deviceId: decodeURIComponent(parts[1]) };
  } catch {
    return null;
  }
}

/**
 * The tabs a chat shows for its live sessions: closed ones stay hidden, user
 * order wins, and a session the agent opened elsewhere joins at the end.
 */
export function visibleDeviceTabs(
  tabs: ChatDeviceTabs,
  sessions: readonly DeviceTarget[],
  deviceName: (target: DeviceTarget) => string | undefined,
): DeviceTab[] {
  const live = new Map(sessions.map((session) => [deviceTabKey(session), session]));
  const dismissed = new Set(tabs.dismissed);
  const ordered = [
    ...tabs.order.filter((key) => live.has(key)),
    ...[...live.keys()].filter((key) => !tabs.order.includes(key)),
  ];
  return ordered
    .filter((key) => !dismissed.has(key))
    .map((key) => {
      const target = live.get(key)!;
      const custom = tabs.titles[key];
      return {
        key,
        hostId: target.hostId,
        deviceId: target.deviceId,
        title: custom ?? deviceName(target) ?? "Device",
        custom: custom !== undefined,
      };
    });
}

/** The selected device tab key, falling back to the first tab; null selects the picker. */
export function selectedDeviceTab(tabs: ChatDeviceTabs, visible: readonly DeviceTab[]): string | null {
  if (tabs.active && visible.some((tab) => tab.key === tabs.active)) return tabs.active;
  if (tabs.picker || visible.length === 0) return null;
  return visible[0].key;
}

/** Whether the strip shows the picker tab: on request, and always when no device is open. */
export function showsDevicePicker(tabs: ChatDeviceTabs, visible: readonly DeviceTab[]): boolean {
  return tabs.picker || visible.length === 0;
}

/** Opening a device (user or agent) brings its tab back and selects it. */
export function openDeviceTab(tabs: ChatDeviceTabs, key: string): ChatDeviceTabs {
  return {
    ...tabs,
    order: tabs.order.includes(key) ? tabs.order : [...tabs.order, key].slice(-MAX_KEYS_PER_CHAT),
    dismissed: tabs.dismissed.filter((entry) => entry !== key),
    active: key,
    picker: false,
  };
}

export function selectDeviceTab(tabs: ChatDeviceTabs, key: string): ChatDeviceTabs {
  return tabs.active === key && !tabs.picker ? tabs : { ...tabs, active: key };
}

export function openDevicePicker(tabs: ChatDeviceTabs): ChatDeviceTabs {
  return tabs.picker && tabs.active === null ? tabs : { ...tabs, picker: true, active: null };
}

export function closeDevicePicker(tabs: ChatDeviceTabs): ChatDeviceTabs {
  return tabs.picker ? { ...tabs, picker: false } : tabs;
}

/**
 * Closing a tab dismisses it for good: the viewer session closes too, and if
 * that close fails or a refresh still lists the session, the tab stays closed.
 * Selection moves to the tab on its left, like the panel's other tabs.
 */
export function closeDeviceTab(
  tabs: ChatDeviceTabs,
  key: string,
  visible: readonly DeviceTab[],
): ChatDeviceTabs {
  const index = visible.findIndex((tab) => tab.key === key);
  const remaining = visible.filter((tab) => tab.key !== key);
  const active =
    selectedDeviceTab(tabs, visible) === key
      ? (remaining[Math.max(0, index - 1)]?.key ?? null)
      : tabs.active;
  return {
    ...tabs,
    order: tabs.order.filter((entry) => entry !== key),
    dismissed: tabs.dismissed.includes(key)
      ? tabs.dismissed
      : [...tabs.dismissed, key].slice(-MAX_KEYS_PER_CHAT),
    active,
  };
}

/** A blank name restores the device's own name. */
export function renameDeviceTab(tabs: ChatDeviceTabs, key: string, title: string): ChatDeviceTabs {
  const trimmed = title.replace(/\s+/gu, " ").trim().slice(0, MAX_DEVICE_TAB_TITLE_LENGTH);
  const { [key]: _previous, ...titles } = tabs.titles;
  if (trimmed) titles[key] = trimmed;
  return { ...tabs, titles };
}

/**
 * Forgets dismissals for sessions that no longer exist, so the list stays
 * bounded. A device opened again later is a new session and shows normally.
 */
export function pruneDismissedDeviceTabs(
  tabs: ChatDeviceTabs,
  sessions: readonly DeviceTarget[],
): ChatDeviceTabs {
  const live = new Set(sessions.map(deviceTabKey));
  const dismissed = tabs.dismissed.filter((key) => live.has(key));
  return dismissed.length === tabs.dismissed.length ? tabs : { ...tabs, dismissed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length <= 400 && parseDeviceTabKey(entry) !== null,
      ),
    ),
  ].slice(-MAX_KEYS_PER_CHAT);
}

function parseChatDeviceTabs(value: unknown): ChatDeviceTabs | null {
  if (!isRecord(value)) return null;
  const titles: Record<string, string> = {};
  if (isRecord(value.titles)) {
    for (const [key, title] of Object.entries(value.titles).slice(-MAX_KEYS_PER_CHAT)) {
      if (parseDeviceTabKey(key) && typeof title === "string" && title.trim()) {
        titles[key] = title.trim().slice(0, MAX_DEVICE_TAB_TITLE_LENGTH);
      }
    }
  }
  const active =
    typeof value.active === "string" && parseDeviceTabKey(value.active) ? value.active : null;
  return {
    order: keyList(value.order),
    titles,
    dismissed: keyList(value.dismissed),
    active,
    picker: value.picker === true,
  };
}

export interface StoredDeviceTabs {
  version: 1;
  /** Least recently changed first; the oldest chats fall off past the cap. */
  chats: Record<string, ChatDeviceTabs>;
}

export function parseStoredDeviceTabs(raw: string | null): StoredDeviceTabs {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (!isRecord(data) || data.version !== 1 || !isRecord(data.chats)) throw new Error("legacy");
    const chats: Record<string, ChatDeviceTabs> = {};
    for (const [chatId, entry] of Object.entries(data.chats).slice(-MAX_REMEMBERED_DEVICE_CHATS)) {
      const parsed = chatId && chatId.length <= 200 ? parseChatDeviceTabs(entry) : null;
      if (parsed) chats[chatId] = parsed;
    }
    return { version: 1, chats };
  } catch {
    return { version: 1, chats: {} };
  }
}

/** Moves the chat to the most recent end and drops the oldest past the cap. */
export function withChatDeviceTabs(
  stored: StoredDeviceTabs,
  chatId: string,
  tabs: ChatDeviceTabs,
): StoredDeviceTabs {
  const { [chatId]: _previous, ...rest } = stored.chats;
  const entries = Object.entries({ ...rest, [chatId]: tabs }).slice(-MAX_REMEMBERED_DEVICE_CHATS);
  return { version: 1, chats: Object.fromEntries(entries) };
}

export type DeviceRevealAction = "float" | "tab" | "ignore";

/**
 * Where an agent-opened device appears. It floats over the chat when the user
 * keeps auto-show on and the chat can host the player; otherwise its tab
 * comes forward. Reveals for another chat, or without a device, never float.
 */
export function deviceRevealAction(input: {
  chatId: string;
  activeChatId: string | null;
  target: DeviceTarget | null;
  autoFloat: boolean;
  canFloat: boolean;
}): DeviceRevealAction {
  if (!input.activeChatId || input.chatId !== input.activeChatId) return "ignore";
  return input.target && input.autoFloat && input.canFloat ? "float" : "tab";
}
