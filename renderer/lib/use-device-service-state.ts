/**
 * One shared read of the device service state for the tab strip and the
 * floating player. It reads over IPC only while something that needs it is
 * mounted and enabled, and never refreshes, starts, or installs anything.
 */
import * as React from "react";
import { devicesApi } from "./ipc";
import type { DeviceServiceState } from "../shared/devices";

let cached: DeviceServiceState | null = null;
let consumers = 0;
let unsubscribe: (() => void) | null = null;
let generation = 0;
const listeners = new Set<() => void>();

function publish(next: DeviceServiceState | null): void {
  cached = next;
  for (const listener of [...listeners]) listener();
}

function acquire(): () => void {
  consumers += 1;
  if (consumers === 1) {
    const current = ++generation;
    unsubscribe = devicesApi.onState((next) => {
      if (current === generation) publish(next);
    });
    void devicesApi.getState().then(
      (next) => {
        if (current === generation) publish(next);
      },
      () => undefined,
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumers -= 1;
    if (consumers > 0) return;
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    cached = null;
  };
}

export function useDeviceServiceState(enabled: boolean): DeviceServiceState | null {
  React.useEffect(() => (enabled ? acquire() : undefined), [enabled]);
  const state = React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => cached,
    () => null,
  );
  return enabled ? state : null;
}
