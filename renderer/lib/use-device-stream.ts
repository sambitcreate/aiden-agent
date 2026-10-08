/**
 * A flat device stream with touch and keyboard input, for surfaces smaller
 * than the full viewer (the floating player). It runs only while `active`:
 * turning it off stops decoding and closes the stream and input sockets.
 * The connection rules match `device-viewer.tsx`.
 */
import * as React from "react";
import { devicesApi } from "./ipc";
import {
  createCanvasFrameSink,
  createDeviceStreamClient,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "./device-stream";
import type { DeviceStreamGrant } from "../shared/devices";

/** A burst of rejected grants means the proxy is refusing us, not that one grant expired. */
const MAX_GRANT_RENEWALS_PER_MINUTE = 3;

export type DeviceStreamViewStatus = DeviceStreamStatus | "idle";

export interface DeviceStreamView {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  attachImage(image: HTMLImageElement | null): void;
  mjpegUrl: string | null;
  status: DeviceStreamViewStatus;
  detail: string | undefined;
  screen: DeviceScreenSize | null;
  inputConnected: boolean;
  client(): DeviceStreamClient | null;
  reconnect(): void;
  /** Pointer handlers for the screen element; coordinates are normalized to it. */
  pointer(phase: "begin" | "move" | "end"): (event: React.PointerEvent<HTMLElement>) => void;
  key(phase: "down" | "up"): (event: React.KeyboardEvent<HTMLElement>) => void;
  /** Lifts every key still held, e.g. when the screen loses focus. */
  releaseKeys(): void;
}

function framePoint(element: HTMLElement, event: React.PointerEvent): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width)),
    y: clamp((event.clientY - rect.top) / Math.max(1, rect.height)),
  };
}

export function useDeviceStream(input: { hostId: string; deviceId: string; active: boolean }): DeviceStreamView {
  const { hostId, deviceId, active } = input;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const clientRef = React.useRef<DeviceStreamClient | null>(null);
  const renewalsRef = React.useRef<number[]>([]);
  const pressedKeysRef = React.useRef(new Set<string>());
  const [grant, setGrant] = React.useState<DeviceStreamGrant | null>(null);
  const [status, setStatus] = React.useState<DeviceStreamViewStatus>("idle");
  const [detail, setDetail] = React.useState<string | undefined>();
  const [screen, setScreen] = React.useState<DeviceScreenSize | null>(null);
  const [mjpegUrl, setMjpegUrl] = React.useState<string | null>(null);
  const [inputConnected, setInputConnected] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  const fail = React.useCallback((message: string) => {
    setStatus("error");
    setDetail(message);
  }, []);

  React.useEffect(() => {
    if (!active) {
      setStatus("idle");
      return;
    }
    let current = true;
    setStatus("connecting");
    setDetail(undefined);
    devicesApi
      .streamGrant()
      .then((next) => {
        if (current) setGrant(next);
      })
      .catch((error: unknown) => {
        if (current) fail(error instanceof Error ? error.message : "Could not reach the simulator.");
      });
    return () => {
      current = false;
      setGrant(null);
    };
  }, [active, attempt, fail]);

  React.useEffect(() => {
    if (!active || !grant) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const client = createDeviceStreamClient(
      { hostId, deviceId, grant },
      createCanvasFrameSink(canvas),
      {
        onStatus: (next, message) => {
          setStatus(next);
          setDetail(message);
        },
        onScreen: setScreen,
        onUnauthorized: () => {
          const now = Date.now();
          renewalsRef.current = renewalsRef.current.filter((at) => now - at < 60_000);
          if (renewalsRef.current.length >= MAX_GRANT_RENEWALS_PER_MINUTE) {
            fail("The simulator stream refused access. Reconnect to try again.");
            return;
          }
          renewalsRef.current.push(now);
          setAttempt((value) => value + 1);
        },
        onMjpegFallback: setMjpegUrl,
        onInputConnected: setInputConnected,
      },
    );
    clientRef.current = client;
    client.start();
    const pressed = pressedKeysRef.current;
    return () => {
      for (const code of pressed) client.sendKey(code, "up");
      pressed.clear();
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
      setInputConnected(false);
      setMjpegUrl(null);
    };
  }, [active, grant, hostId, deviceId, fail]);

  // The fallback image mounts only after the running client asked for it.
  const attachImage = React.useCallback((image: HTMLImageElement | null) => {
    clientRef.current?.setMjpegImage(image);
  }, []);

  const releaseKeys = React.useCallback(() => {
    for (const code of pressedKeysRef.current) clientRef.current?.sendKey(code, "up");
    pressedKeysRef.current.clear();
  }, []);

  const pointer = React.useCallback(
    (phase: "begin" | "move" | "end") => (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0 && phase === "begin") return;
      if (phase === "move" && !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      if (phase === "begin") {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
      }
      const point = framePoint(event.currentTarget, event);
      clientRef.current?.sendTouch(phase, point.x, point.y);
      if (phase === "end" && event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  // Tab, Shift+Tab and Command shortcuts stay with the app so keyboard users can always leave.
  const key = React.useCallback(
    (phase: "down" | "up") => (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.code === "Tab" || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (phase === "down" && event.repeat) return;
      if (phase === "down") pressedKeysRef.current.add(event.code);
      else pressedKeysRef.current.delete(event.code);
      clientRef.current?.sendKey(event.code, phase);
    },
    [],
  );

  return {
    canvasRef,
    attachImage,
    mjpegUrl,
    status,
    detail,
    screen,
    inputConnected,
    client: () => clientRef.current,
    reconnect: () => {
      renewalsRef.current = [];
      setAttempt((value) => value + 1);
    },
    pointer,
    key,
    releaseKeys,
  };
}
