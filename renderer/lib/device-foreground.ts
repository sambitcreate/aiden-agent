/**
 * Adapted from t3code apps/web/src/components/device/deviceHubApi.ts @ 1c127066 (MIT)
 *
 * serve-sim pushes the frontmost iOS app over Server-Sent Events whenever it
 * changes. T3 uses EventSource; Aiden reads the stream with `fetch` instead,
 * the same credential-free path the MJPEG stream already takes through main's
 * token proxy from the `file://` renderer.
 */
import type { DeviceStreamGrant } from "../shared/devices";
import { deviceHubUrl } from "./device-stream";

export interface DeviceForegroundApp {
  id: string;
  pid?: number;
}

export interface DeviceForegroundRuntime {
  fetch(url: string, init: { signal: AbortSignal; credentials: "omit" }): Promise<Response>;
}

/** Parses one SSE `data:` payload. `undefined` means "nothing to report", `null` means "no app". */
export function parseForegroundEvent(data: unknown): DeviceForegroundApp | null | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { bundleId, pid } = data as Record<string, unknown>;
  if (bundleId === null || bundleId === "") return null;
  if (typeof bundleId !== "string") return undefined;
  return { id: bundleId, ...(typeof pid === "number" ? { pid } : {}) };
}

/** Splits an SSE byte stream into the `data` of each complete event. */
export function createSseParser(onData: (data: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/gu, "\n");
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) return;
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const lines = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /u, ""));
      if (lines.length > 0) onData(lines.join("\n"));
    }
  };
}

/** Follows the frontmost app until the returned function is called. Failures just end the feed. */
export function subscribeDeviceForeground(
  target: { hostId: string; deviceId: string; grant: DeviceStreamGrant },
  onChange: (app: DeviceForegroundApp | null) => void,
  runtime: DeviceForegroundRuntime = { fetch: (url, init) => fetch(url, init) },
): () => void {
  const controller = new AbortController();
  const url = deviceHubUrl(
    target,
    `/vendor/serve-sim/appstate?device=${encodeURIComponent(target.deviceId)}`,
    "http",
  );
  const parse = createSseParser((data) => {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const app = parseForegroundEvent(payload);
    if (app !== undefined && !controller.signal.aborted) onChange(app);
  });
  void (async () => {
    try {
      const response = await runtime.fetch(url, { signal: controller.signal, credentials: "omit" });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted) return;
        parse(value);
      }
    } catch {
      // The drawer falls back to "—" when the feed is unavailable.
    }
  })();
  return () => controller.abort();
}
