/**
 * Adapted from t3code apps/web/src/components/device/deviceFold.ts and
 * DeviceAndroidFoldControls.tsx @ a6ec88f7 (MIT)
 *
 * Android foldable emulators report their hinge through serve-emu's
 * `/api/fold` (GET reads, POST `{ posture }` folds or unfolds). Capability
 * comes from the emulator, never from its AVD name or screen size.
 *
 * The controller re-reads whenever the screen size changes (a fold restarts
 * the encoder at the other display's size), retries a failed read every 3 s,
 * and gives up on a fold command after 12 s. `useAndroidFold` exposes the
 * result, including the hinge angle the 3D viewer can render.
 */
import * as React from "react";
import type { DeviceStreamGrant } from "../shared/devices";
import { deviceHubUrl } from "./device-stream";

export type AndroidFoldPosture = "closed" | "opened";
export type AndroidFoldReportedPosture = "closed" | "half_opened" | "opened" | "flipped" | "tent";

export interface AndroidFoldState {
  supported: boolean;
  posture: AndroidFoldReportedPosture | null;
  /** Degrees, 0 folded flat to 180 open; null when the emulator did not report it. */
  hingeAngle: number | null;
}

export const ANDROID_FOLD_RETRY_MS = 3_000;
export const ANDROID_FOLD_TIMEOUT_MS = 12_000;
export const ANDROID_FOLD_TIMEOUT_MESSAGE = "Fold command timed out.";

const POSTURES: readonly AndroidFoldReportedPosture[] = ["closed", "half_opened", "opened", "flipped", "tent"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseAndroidFold(payload: unknown): AndroidFoldState {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.fold)) {
    throw new Error("Unexpected Android fold response.");
  }
  const { supported, posture, hingeAngle } = payload.fold;
  if (
    typeof supported !== "boolean" ||
    (posture !== null && !POSTURES.includes(posture as AndroidFoldReportedPosture)) ||
    (hingeAngle !== null && (typeof hingeAngle !== "number" || !Number.isFinite(hingeAngle)))
  ) {
    throw new Error("Unexpected Android fold response.");
  }
  return { supported, posture: posture as AndroidFoldReportedPosture | null, hingeAngle: hingeAngle as number | null };
}

/** The hinge angle to render: the reported angle, else 0 when closed and 180 otherwise. Null when unsupported. */
export function androidFoldAngle(state: AndroidFoldState | null): number | null {
  if (!state?.supported) return null;
  return state.hingeAngle ?? (state.posture === "closed" ? 0 : 180);
}

export interface AndroidFoldTarget {
  hostId: string;
  deviceId: string;
  grant: DeviceStreamGrant;
}

export interface AndroidFoldRuntime {
  fetch(
    url: string,
    init: { method: "GET" | "POST"; cache: "no-store"; credentials: "omit"; headers?: Record<string, string>; body?: string; signal: AbortSignal },
  ): Promise<Response>;
}

/** One `/api/fold` request through main's proxy. A refusal carries serve-emu's own message. */
export async function requestAndroidFold(
  target: AndroidFoldTarget,
  posture: AndroidFoldPosture | null,
  signal: AbortSignal,
  runtime: AndroidFoldRuntime = { fetch: (url, init) => fetch(url, init) },
): Promise<AndroidFoldState> {
  const url = deviceHubUrl(
    target,
    `/vendor/serve-emu/api/fold?${new URLSearchParams({ device: target.deviceId })}`,
    "http",
  );
  const response = await runtime.fetch(url, {
    method: posture ? "POST" : "GET",
    cache: "no-store",
    credentials: "omit",
    signal,
    ...(posture ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ posture }) } : {}),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const error = isRecord(payload) ? payload.error : null;
    throw new Error(typeof error === "string" && error ? error : `Fold command failed (${response.status}).`);
  }
  return parseAndroidFold(await response.json());
}

export interface AndroidFoldSnapshot {
  fold: AndroidFoldState | null;
  /** The angle to render, moving ahead of a pending command. */
  angle: number | null;
  pending: boolean;
  error: string | null;
}

type Timer = ReturnType<typeof setTimeout>;

export interface AndroidFoldController {
  /** Reads now and keeps retrying until a read lands. Call again when the screen size changes. */
  watch(): void;
  /** Stops reading; a command already sent still settles. */
  pause(): void;
  change(posture: AndroidFoldPosture): Promise<void>;
  snapshot(): AndroidFoldSnapshot;
  dispose(): void;
}

export function createAndroidFoldController(options: {
  read(signal: AbortSignal): Promise<AndroidFoldState>;
  write(posture: AndroidFoldPosture, signal: AbortSignal): Promise<AndroidFoldState>;
  onChange(snapshot: AndroidFoldSnapshot): void;
  setTimeout?(callback: () => void, ms: number): Timer;
  clearTimeout?(timer: Timer): void;
}): AndroidFoldController {
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  let state: AndroidFoldSnapshot = { fold: null, angle: null, pending: false, error: null };
  let reading: AbortController | null = null;
  let retry: Timer | null = null;
  let watching = false;
  let disposed = false;
  const set = (next: Partial<AndroidFoldSnapshot>) => {
    state = { ...state, ...next };
    if (!disposed) options.onChange(state);
  };
  const stopReading = () => {
    reading?.abort();
    reading = null;
    if (retry !== null) cancel(retry);
    retry = null;
  };
  const read = () => {
    stopReading();
    // A command in flight re-reads when it settles.
    if (!watching || disposed || state.pending) return;
    const controller = new AbortController();
    reading = controller;
    options.read(controller.signal).then(
      (fold) => {
        if (controller.signal.aborted || reading !== controller) return;
        reading = null;
        set({ fold, angle: androidFoldAngle(fold) });
      },
      () => {
        if (controller.signal.aborted || reading !== controller) return;
        reading = null;
        retry = schedule(() => {
          retry = null;
          read();
        }, ANDROID_FOLD_RETRY_MS);
      },
    );
  };
  return {
    watch() {
      watching = true;
      read();
    },
    pause() {
      watching = false;
      stopReading();
    },
    async change(posture) {
      if (disposed || state.pending || !state.fold?.supported) return;
      stopReading();
      const before = state.fold;
      set({ pending: true, error: null, angle: posture === "closed" ? 0 : 180 });
      const controller = new AbortController();
      const timeout = schedule(() => controller.abort(), ANDROID_FOLD_TIMEOUT_MS);
      try {
        const fold = await options.write(posture, controller.signal);
        set({ fold, angle: androidFoldAngle(fold) });
      } catch (cause) {
        set({
          angle: androidFoldAngle(before),
          error: controller.signal.aborted
            ? ANDROID_FOLD_TIMEOUT_MESSAGE
            : cause instanceof Error && cause.message
              ? cause.message
              : "Could not change the fold posture.",
        });
      } finally {
        cancel(timeout);
        set({ pending: false });
        read();
      }
    },
    snapshot: () => state,
    dispose() {
      disposed = true;
      watching = false;
      stopReading();
    },
  };
}

/** What the viewer, the fold controls, and the 3D frame read about an Android foldable. */
export interface AndroidFoldView extends AndroidFoldSnapshot {
  /** The emulator has a hinge sensor. False until the first read lands. */
  supported: boolean;
  change(posture: AndroidFoldPosture): void;
}

/**
 * Follows one Android emulator's fold state while `enabled` (streaming with
 * input up). `screenKey` changes whenever the decoded screen size does; a
 * fresh grant is minted for every request because grants are short-lived.
 */
export function useAndroidFold(options: {
  hostId: string;
  deviceId: string;
  enabled: boolean;
  screenKey: string | null;
  mintGrant(): Promise<DeviceStreamGrant>;
}): AndroidFoldView {
  const { hostId, deviceId, enabled, screenKey, mintGrant } = options;
  const [snapshot, setSnapshot] = React.useState<AndroidFoldSnapshot>({
    fold: null,
    angle: null,
    pending: false,
    error: null,
  });
  const mintRef = React.useRef(mintGrant);
  mintRef.current = mintGrant;
  const controller = React.useMemo(() => {
    const target = async () => ({ hostId, deviceId, grant: await mintRef.current() });
    return createAndroidFoldController({
      read: async (signal) => requestAndroidFold(await target(), null, signal),
      write: async (posture, signal) => requestAndroidFold(await target(), posture, signal),
      onChange: setSnapshot,
    });
  }, [hostId, deviceId]);
  React.useEffect(() => () => controller.dispose(), [controller]);
  React.useEffect(() => {
    if (!enabled || !screenKey) return;
    controller.watch();
    return () => controller.pause();
  }, [controller, enabled, screenKey]);
  return {
    ...snapshot,
    supported: snapshot.fold?.supported === true,
    change: (posture) => void controller.change(posture),
  };
}
