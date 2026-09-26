/**
 * Adapted from t3code apps/web/src/components/device/useDeviceControls.ts @ 1c127066 (MIT)
 *
 * One confirmed settings snapshot plus serialized actions for the Simulator
 * rail and the Device tools drawer. Every change is an action round trip;
 * the settings main returns replace local state, so the controls never show a
 * value the simulator did not confirm.
 */
import * as React from "react";
import { devicesApi } from "./ipc";
import { subscribeDeviceForeground, type DeviceForegroundApp } from "./device-foreground";
import type { DeviceActionInput, DeviceSettings, DeviceStreamGrant } from "../shared/devices";

type Distribute<T> = T extends unknown ? Omit<T, "hostId" | "deviceId"> : never;
export type DeviceActionBody = Distribute<DeviceActionInput>;

export interface DeviceControlsState {
  /** `null` until the first read settles successfully. */
  settings: DeviceSettings | null;
  pending: boolean;
  error: string | null;
}

export interface DeviceControlsController {
  /** Reads settings while shown. Results that land after `hide` or a newer action are dropped. */
  show(): void;
  hide(): void;
  /** Runs one action. Returns false without running when another action is in flight. */
  act(body: DeviceActionBody): Promise<boolean>;
  getState(): DeviceControlsState;
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function createDeviceControls(options: {
  target: { hostId: string; deviceId: string };
  read(target: { hostId: string; deviceId: string }): Promise<DeviceSettings>;
  run(input: DeviceActionInput): Promise<DeviceSettings>;
  onChange(state: DeviceControlsState): void;
}): DeviceControlsController {
  let state: DeviceControlsState = { settings: null, pending: false, error: null };
  let visible = false;
  // Hiding invalidates results but never cancels a host command, so actions
  // stay serialized until they settle.
  let busy = false;
  let generation = 0;
  const set = (next: Partial<DeviceControlsState>) => {
    state = { ...state, ...next };
    options.onChange(state);
  };
  const read = (revision: number) =>
    options.read(options.target).then(
      (settings) => {
        if (generation === revision) set({ settings, error: null });
      },
      (error: unknown) => {
        if (generation === revision) set({ settings: null, error: message(error, "Could not read the simulator settings.") });
      },
    );
  return {
    show() {
      visible = true;
      void read(++generation);
    },
    hide() {
      visible = false;
      generation++;
    },
    async act(body) {
      if (busy || !visible || state.settings === null) return false;
      busy = true;
      const revision = ++generation;
      set({ pending: true, error: null });
      try {
        const settings = await options.run({ ...options.target, ...body } as DeviceActionInput);
        if (generation === revision) set({ settings });
        // The drawer was hidden and reopened mid-action: confirm what the device now reports.
        else if (visible) await read(++generation);
        return true;
      } catch (error) {
        if (generation === revision) set({ error: message(error, "The simulator action failed.") });
        return false;
      } finally {
        busy = false;
        set({ pending: false });
      }
    },
    getState: () => state,
  };
}

export interface DeviceControls extends DeviceControlsState {
  act(body: DeviceActionBody): Promise<boolean>;
  /** True while an action runs or before settings are known. */
  disabled: boolean;
  /** The frontmost app from serve-sim's feed, or `null` when there is none or the feed is unavailable. */
  foregroundApp: DeviceForegroundApp | null;
}

/** Mount keyed by device. Reads and follows the device only while `visible`. */
export function useDeviceControls(options: {
  hostId: string;
  deviceId: string;
  grant: DeviceStreamGrant | null;
  visible: boolean;
}): DeviceControls {
  const { hostId, deviceId, grant, visible } = options;
  const [state, setState] = React.useState<DeviceControlsState>({
    settings: null,
    pending: false,
    error: null,
  });
  const [foregroundApp, setForegroundApp] = React.useState<DeviceForegroundApp | null>(null);
  const controller = React.useMemo(
    () =>
      createDeviceControls({
        target: { hostId, deviceId },
        read: devicesApi.settings,
        run: devicesApi.action,
        onChange: setState,
      }),
    [hostId, deviceId],
  );

  React.useEffect(() => {
    if (!visible) return;
    controller.show();
    return () => controller.hide();
  }, [controller, visible]);

  React.useEffect(() => {
    if (!visible || !grant) return;
    const unsubscribe = subscribeDeviceForeground({ hostId, deviceId, grant }, setForegroundApp);
    return () => {
      unsubscribe();
      setForegroundApp(null);
    };
  }, [hostId, deviceId, grant, visible]);

  return {
    ...state,
    act: controller.act,
    disabled: state.pending || state.settings === null || !visible,
    foregroundApp,
  };
}
