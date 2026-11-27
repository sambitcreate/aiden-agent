/**
 * One shared read of the device service state for the tab strip and the
 * floating player. It reads over IPC only while something that needs it is
 * mounted and enabled, and never refreshes, starts, or installs anything.
 */
import { devicesApi } from "./ipc";
import { createSharedSnapshot } from "./shared-snapshot";
import type { DeviceServiceState } from "../shared/devices";

const deviceServiceSnapshot = createSharedSnapshot<DeviceServiceState | null>({
  empty: null,
  subscribe: (onValue) => devicesApi.onState(onValue),
  read: () => devicesApi.getState(),
  ignoreReadAfterPush: false,
});

export function useDeviceServiceState(enabled: boolean): DeviceServiceState | null {
  return deviceServiceSnapshot.useSnapshot(enabled);
}
