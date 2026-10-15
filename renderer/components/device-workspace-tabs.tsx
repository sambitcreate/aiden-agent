import * as React from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Input,
  toast,
} from "./ui";
import { devicesApi } from "../lib/ipc";
import {
  closeDevicePicker,
  closeDeviceTab,
  deviceTabKey,
  openDevicePicker,
  openDeviceTab,
  parseDeviceTabKey,
  pruneDismissedDeviceTabs,
  renameDeviceTab,
  selectDeviceTab,
  selectedDeviceTab,
  showsDevicePicker,
  visibleDeviceTabs,
  MAX_DEVICE_TAB_TITLE_LENGTH,
  type DeviceTab,
  type DeviceTarget,
} from "../lib/device-tabs";
import { deviceWorkspace, useChatDeviceTabs, useFloatingDevice } from "../lib/device-workspace-store";
import { useDeviceServiceState } from "../lib/use-device-service-state";
import type { DeviceServiceState } from "../shared/devices";

/** The device picker's tab label, and the launcher entry that opens it. */
export const DEVICE_PICKER_LABEL = "Device";

/** One strip entry for the device kind: a device tab, or the picker (`key` null). */
export interface DeviceStripEntry {
  key: string | null;
  label: string;
  selected: boolean;
}

export interface DeviceTabsController {
  /** The strip entries, in order: device tabs, then the picker when it shows. */
  entries: DeviceStripEntry[];
  /** The device session the panel shows, or null for the picker. */
  selected: DeviceTarget | null;
  /** The device floating over the chat, whose tab shows a placeholder instead of streaming. */
  floating: string | null;
  state: DeviceServiceState | null;
  select(key: string | null): void;
  /**
   * Closes a tab and its viewer session (never the simulator). Returns whether
   * no device entry remains, so the caller can close the device kind.
   */
  close(key: string | null): boolean;
  /** Hides a tab whose session the caller is already closing. */
  dismiss(key: string): void;
  rename(key: string, title: string): void;
  openPicker(): void;
  float(key: string): void;
  /** Records a device the user just opened as the selected tab. */
  opened(target: DeviceTarget): void;
}

/**
 * Wires the per-chat device tabs to the live device sessions. It reads the
 * service state only while the device kind is open in the strip.
 */
export function useDeviceTabs(chatId: string | null, enabled: boolean): DeviceTabsController {
  const tabs = useChatDeviceTabs(chatId);
  const floating = useFloatingDevice(chatId);
  const state = useDeviceServiceState(enabled && Boolean(chatId));
  const sessions = React.useMemo(
    () =>
      chatId && state
        ? state.sessions
            .filter((session) => session.chatId === chatId)
            .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }))
        : [],
    [chatId, state],
  );
  const visible = React.useMemo(
    () =>
      visibleDeviceTabs(
        tabs,
        sessions,
        (target) =>
          state?.devices.find((device) => device.hostId === target.hostId && device.id === target.deviceId)?.name,
      ),
    [sessions, state, tabs],
  );
  // Dismissals only matter while their session still exists.
  React.useEffect(() => {
    if (chatId && state) deviceWorkspace.updateTabs(chatId, (current) => pruneDismissedDeviceTabs(current, sessions));
  }, [chatId, sessions, state]);
  const selectedKey = selectedDeviceTab(tabs, visible);
  const picker = showsDevicePicker(tabs, visible);
  const entries: DeviceStripEntry[] = [
    ...visible.map((tab: DeviceTab) => ({ key: tab.key, label: tab.title, selected: tab.key === selectedKey })),
    ...(picker ? [{ key: null, label: DEVICE_PICKER_LABEL, selected: selectedKey === null }] : []),
  ];
  const update = (change: Parameters<typeof deviceWorkspace.updateTabs>[1]) => {
    if (chatId) deviceWorkspace.updateTabs(chatId, change);
  };
  const dismiss = (key: string) => {
    if (!chatId) return;
    update((current) => closeDeviceTab(current, key, visible));
    if (floating === key) deviceWorkspace.setFloating(chatId, null);
  };
  return {
    entries,
    selected: selectedKey ? parseDeviceTabKey(selectedKey) : null,
    floating,
    state,
    select: (key) => update((current) => (key ? selectDeviceTab(current, key) : openDevicePicker(current))),
    close(key) {
      if (!chatId) return true;
      if (key === null) {
        update(closeDevicePicker);
        return visible.length === 0;
      }
      const target = parseDeviceTabKey(key);
      dismiss(key);
      // Closing the tab ends this chat's viewer session; the simulator keeps running.
      if (target) {
        void devicesApi
          .close({ chatId, hostId: target.hostId, deviceId: target.deviceId, shutdown: false })
          .catch((reason: unknown) =>
            toast.error(reason instanceof Error ? reason.message : "Could not close the device."),
          );
      }
      return visible.length <= 1 && !tabs.picker;
    },
    dismiss,
    rename: (key, title) => update((current) => renameDeviceTab(current, key, title)),
    openPicker: () => update(openDevicePicker),
    float(key) {
      if (!chatId) return;
      update((current) => selectDeviceTab(current, key));
      deviceWorkspace.setFloating(chatId, key);
    },
    opened: (target) => update((current) => openDeviceTab(current, deviceTabKey(target))),
  };
}

/** Inline rename field for a device tab. Enter or blur saves; Escape keeps the old name. */
export function DeviceTabRenameInput({
  title,
  onCommit,
  onCancel,
}: {
  title: string;
  onCommit(title: string): void;
  onCancel(): void;
}) {
  const doneRef = React.useRef(false);
  return (
    <Input
      aria-label="Device tab name"
      defaultValue={title}
      maxLength={MAX_DEVICE_TAB_TITLE_LENGTH}
      className="h-7 w-32 px-2 text-small"
      ref={(element) => {
        if (element && !element.dataset.focused) {
          element.dataset.focused = "true";
          element.focus();
          element.select();
        }
      }}
      onBlur={(event) => {
        if (doneRef.current) return;
        doneRef.current = true;
        onCommit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          doneRef.current = true;
          onCommit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          doneRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

/** Rename, float, and close a device tab from its context menu. */
export function DeviceTabContextMenu({
  children,
  floating,
  onRename,
  onFloat,
  onClose,
}: React.PropsWithChildren<{
  floating: boolean;
  onRename(): void;
  onFloat(): void;
  onClose(): void;
}>) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRename}>Rename</ContextMenuItem>
        <ContextMenuItem disabled={floating} onSelect={onFloat}>
          Float over chat
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onClose}>Close tab</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
