import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CHAT_DEVICE_TABS,
  MAX_DEVICE_TAB_TITLE_LENGTH,
  MAX_REMEMBERED_DEVICE_CHATS,
  closeDeviceTab,
  deviceRevealAction,
  deviceTabKey,
  openDevicePicker,
  openDeviceTab,
  parseDeviceTabKey,
  parseStoredDeviceTabs,
  pruneDismissedDeviceTabs,
  renameDeviceTab,
  selectedDeviceTab,
  showsDevicePicker,
  visibleDeviceTabs,
  withChatDeviceTabs,
  type ChatDeviceTabs,
  type DeviceTarget,
} from "./device-tabs.js";
import { createDeviceWorkspaceStore, DEVICE_TABS_STORAGE_KEY } from "./device-workspace-store.js";

const PHONE: DeviceTarget = { hostId: "local", deviceId: "UDID-PHONE" };
const PAD: DeviceTarget = { hostId: "local", deviceId: "UDID-PAD" };
const PEER: DeviceTarget = { hostId: "peer:mac-2", deviceId: "UDID-PHONE" };
const NAMES: Record<string, string> = {
  [deviceTabKey(PHONE)]: "iPhone 17 Pro",
  [deviceTabKey(PAD)]: "iPad Air",
  [deviceTabKey(PEER)]: "iPhone on Studio",
};
const name = (target: DeviceTarget) => NAMES[deviceTabKey(target)];
const titles = (tabs: ChatDeviceTabs, sessions: DeviceTarget[]) =>
  visibleDeviceTabs(tabs, sessions, name).map((tab) => tab.title);

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("each open session gets its own tab, named after its device", () => {
  assert.deepEqual(titles(EMPTY_CHAT_DEVICE_TABS, [PHONE, PAD]), ["iPhone 17 Pro", "iPad Air"]);
  // The same simulator on a paired Mac is a different tab.
  assert.equal(visibleDeviceTabs(EMPTY_CHAT_DEVICE_TABS, [PHONE, PEER], name).length, 2);
  assert.deepEqual(parseDeviceTabKey(deviceTabKey(PEER)), PEER);
});

test("opening a device selects its tab and keeps the user's order", () => {
  let tabs = openDeviceTab(EMPTY_CHAT_DEVICE_TABS, deviceTabKey(PAD));
  tabs = openDeviceTab(tabs, deviceTabKey(PHONE));
  const visible = visibleDeviceTabs(tabs, [PHONE, PAD], name);
  assert.deepEqual(visible.map((tab) => tab.title), ["iPad Air", "iPhone 17 Pro"]);
  assert.equal(selectedDeviceTab(tabs, visible), deviceTabKey(PHONE));
  assert.equal(showsDevicePicker(tabs, visible), false);
});

test("the picker stays reachable: it shows with no devices and on request", () => {
  assert.equal(showsDevicePicker(EMPTY_CHAT_DEVICE_TABS, []), true);
  assert.equal(selectedDeviceTab(EMPTY_CHAT_DEVICE_TABS, []), null);
  const open = openDeviceTab(EMPTY_CHAT_DEVICE_TABS, deviceTabKey(PHONE));
  const picker = openDevicePicker(open);
  const visible = visibleDeviceTabs(picker, [PHONE], name);
  assert.equal(showsDevicePicker(picker, visible), true);
  assert.equal(selectedDeviceTab(picker, visible), null);
  // Choosing a device from the picker replaces it with that device's tab.
  const chosen = openDeviceTab(picker, deviceTabKey(PAD));
  assert.equal(showsDevicePicker(chosen, visibleDeviceTabs(chosen, [PHONE, PAD], name)), false);
});

test("renaming persists per tab, trims, caps, and a blank name restores the device name", () => {
  const key = deviceTabKey(PHONE);
  let tabs = renameDeviceTab(EMPTY_CHAT_DEVICE_TABS, key, "  Checkout   flow  ");
  assert.deepEqual(titles(tabs, [PHONE, PAD]), ["Checkout flow", "iPad Air"]);
  tabs = renameDeviceTab(tabs, key, "x".repeat(200));
  assert.equal(titles(tabs, [PHONE])[0].length, MAX_DEVICE_TAB_TITLE_LENGTH);
  tabs = renameDeviceTab(tabs, key, "   ");
  assert.deepEqual(titles(tabs, [PHONE]), ["iPhone 17 Pro"]);
  assert.equal(visibleDeviceTabs(tabs, [PHONE], name)[0].custom, false);
});

test("a closed tab stays closed while its session is still listed, and selection moves left", () => {
  let tabs = openDeviceTab(EMPTY_CHAT_DEVICE_TABS, deviceTabKey(PHONE));
  tabs = openDeviceTab(tabs, deviceTabKey(PAD));
  tabs = closeDeviceTab(tabs, deviceTabKey(PAD), visibleDeviceTabs(tabs, [PHONE, PAD], name));
  // A refresh still lists the iPad session (the close is in flight or failed): no resurrection.
  const visible = visibleDeviceTabs(tabs, [PHONE, PAD], name);
  assert.deepEqual(visible.map((tab) => tab.title), ["iPhone 17 Pro"]);
  assert.equal(selectedDeviceTab(tabs, visible), deviceTabKey(PHONE));
  // Closing the last tab leaves the picker.
  tabs = closeDeviceTab(tabs, deviceTabKey(PHONE), visible);
  assert.deepEqual(titles(tabs, [PHONE, PAD]), []);
  assert.equal(showsDevicePicker(tabs, []), true);
});

test("once a closed session ends, opening that device again shows it with its saved name", () => {
  const key = deviceTabKey(PHONE);
  let tabs = renameDeviceTab(openDeviceTab(EMPTY_CHAT_DEVICE_TABS, key), key, "Login");
  tabs = closeDeviceTab(tabs, key, visibleDeviceTabs(tabs, [PHONE], name));
  tabs = pruneDismissedDeviceTabs(tabs, []);
  assert.deepEqual(tabs.dismissed, []);
  // An agent (or the user) opens it again: a new session, shown normally under the saved name.
  assert.deepEqual(titles(tabs, [PHONE]), ["Login"]);
  // While the old session still exists, only an explicit open brings it back.
  const dismissed = closeDeviceTab(tabs, key, visibleDeviceTabs(tabs, [PHONE], name));
  assert.deepEqual(titles(pruneDismissedDeviceTabs(dismissed, [PHONE]), [PHONE]), []);
  assert.deepEqual(titles(openDeviceTab(dismissed, key), [PHONE]), ["Login"]);
});

test("stored tabs survive a reload, drop malformed entries, and forget the oldest chats", () => {
  const storage = memoryStorage();
  const first = createDeviceWorkspaceStore(storage);
  first.updateTabs("chat-1", (tabs) => renameDeviceTab(openDeviceTab(tabs, deviceTabKey(PHONE)), deviceTabKey(PHONE), "Demo"));
  first.updateTabs("chat-1", (tabs) => closeDeviceTab(tabs, deviceTabKey(PAD), visibleDeviceTabs(tabs, [PHONE, PAD], name)));
  const reloaded = createDeviceWorkspaceStore(storage);
  assert.deepEqual(titles(reloaded.tabs("chat-1"), [PHONE, PAD]), ["Demo"]);
  assert.deepEqual(reloaded.tabs("chat-2"), EMPTY_CHAT_DEVICE_TABS);

  const corrupt = parseStoredDeviceTabs(
    JSON.stringify({ version: 1, chats: { ok: { order: ["bad", deviceTabKey(PHONE), 4], titles: { nope: "x" }, active: "zz" } } }),
  );
  assert.deepEqual(corrupt.chats.ok.order, [deviceTabKey(PHONE)]);
  assert.deepEqual(corrupt.chats.ok.titles, {});
  assert.equal(corrupt.chats.ok.active, null);
  assert.deepEqual(parseStoredDeviceTabs("{not json").chats, {});
  assert.deepEqual(parseStoredDeviceTabs(JSON.stringify({ version: 0, tabs: [] })).chats, {});

  let stored = parseStoredDeviceTabs(null);
  for (let index = 0; index <= MAX_REMEMBERED_DEVICE_CHATS; index += 1) {
    stored = withChatDeviceTabs(stored, `chat-${index}`, openDeviceTab(EMPTY_CHAT_DEVICE_TABS, deviceTabKey(PHONE)));
  }
  assert.equal(Object.keys(stored.chats).length, MAX_REMEMBERED_DEVICE_CHATS);
  assert.equal(stored.chats["chat-0"], undefined);
  assert.ok(stored.chats[`chat-${MAX_REMEMBERED_DEVICE_CHATS}`]);
});

test("the store notifies once per real change and keeps working when storage throws", () => {
  const storage = memoryStorage();
  const store = createDeviceWorkspaceStore(storage);
  let notified = 0;
  store.subscribe(() => notified++);
  store.updateTabs("chat-1", (tabs) => tabs);
  store.setFloating("chat-1", null);
  assert.equal(notified, 0);
  store.setFloating("chat-1", deviceTabKey(PHONE));
  store.setFloating("chat-1", deviceTabKey(PHONE));
  assert.equal(notified, 1);
  assert.equal(store.floating("chat-1"), deviceTabKey(PHONE));
  assert.equal(store.floating("chat-2"), null);

  const broken = createDeviceWorkspaceStore({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("quota");
    },
  });
  broken.updateTabs("chat-1", (tabs) => openDeviceTab(tabs, deviceTabKey(PAD)));
  assert.equal(broken.tabs("chat-1").active, deviceTabKey(PAD));
  assert.equal(broken.autoFloat(), true);
  assert.equal(storage.values.has(DEVICE_TABS_STORAGE_KEY), false);
});

test("an agent-opened device floats over its chat only when auto-show is on", () => {
  const base = { chatId: "chat-1", activeChatId: "chat-1", target: PHONE, autoFloat: true, canFloat: true };
  assert.equal(deviceRevealAction(base), "float");
  assert.equal(deviceRevealAction({ ...base, autoFloat: false }), "tab");
  // An older reveal without a device, or a chat that cannot host the player, opens the tab.
  assert.equal(deviceRevealAction({ ...base, target: null }), "tab");
  assert.equal(deviceRevealAction({ ...base, canFloat: false }), "tab");
  // Another chat's agent never moves this chat's workspace.
  assert.equal(deviceRevealAction({ ...base, activeChatId: "chat-2" }), "ignore");
  assert.equal(deviceRevealAction({ ...base, activeChatId: null }), "ignore");
});

test("the auto-show preference defaults on and persists when turned off", () => {
  const storage = memoryStorage();
  const store = createDeviceWorkspaceStore(storage);
  assert.equal(store.autoFloat(), true);
  store.setAutoFloat(false);
  assert.equal(createDeviceWorkspaceStore(storage).autoFloat(), false);
  store.setAutoFloat(true);
  assert.equal(createDeviceWorkspaceStore(storage).autoFloat(), true);
});
