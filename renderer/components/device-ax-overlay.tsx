/**
 * Adapted from t3code apps/web/src/components/device/DeviceStreamView.tsx @ a6ec88f7 (MIT)
 *
 * Draws the device's accessibility element frames over the flat screen.
 * Frames follow the device's rotation (see `axRectToDisplay`). Hovering the
 * screen names the element under the pointer and its role. On this Mac the
 * tree is re-read two seconds (an emulator: three) after each read while the
 * overlay is on; a paired Mac's tree is read once per request, so nothing
 * polls a remote host.
 */
import * as React from "react";
import {
  DeviceAxUnauthorizedError,
  axRectToDisplay,
  fetchDeviceAxTree,
  hitTestAxElements,
  type DeviceAxElement,
} from "../lib/device-ax";
import type { DeviceGrantSource } from "../lib/device-grant";
import type { DeviceScreenSize } from "../lib/device-stream";
import type { DevicePlatform } from "../shared/devices";

export const DEVICE_AX_POLL_MS = 2_000;
/** `uiautomator dump` takes two to three seconds on an emulator, so its reads are spaced further apart. */
export const ANDROID_AX_POLL_MS = 3_000;

export interface DeviceAxStatus {
  loading: boolean;
  count: number;
  error: string | null;
}

export function DeviceAxOverlay(props: {
  hostId: string;
  deviceId: string;
  /** iOS reads serve-sim's tree; Android reads serve-emu's `uiautomator` dump. */
  platform?: DevicePlatform;
  grants: DeviceGrantSource;
  screen: DeviceScreenSize | null;
  /** The flat screen element; hover is read from its pointer events. */
  screenRef: React.RefObject<HTMLElement | null>;
  /** Polls while true. A paired Mac is read once per `refreshKey` change instead. */
  poll: boolean;
  refreshKey: number;
  onStatus(status: DeviceAxStatus): void;
}) {
  const { hostId, deviceId, grants, poll, refreshKey, onStatus } = props;
  const platform = props.platform ?? "ios";
  const [tree, setTree] = React.useState<{ elements: DeviceAxElement[]; root: { width: number; height: number } | null }>({
    elements: [],
    root: null,
  });
  const [hovered, setHovered] = React.useState<DeviceAxElement | null>(null);

  React.useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    onStatus({ loading: true, count: 0, error: null });
    const read = async () => {
      controller = new AbortController();
      try {
        const grant = await grants.get();
        if (stopped) return;
        const next = await fetchDeviceAxTree({ hostId, deviceId, grant, platform }, controller.signal);
        if (stopped) return;
        setTree({ elements: next.elements, root: next.root });
        onStatus({ loading: false, count: next.elements.length, error: next.errors[0] ?? null });
      } catch (error) {
        if (stopped) return;
        if (error instanceof DeviceAxUnauthorizedError) grants.invalidate();
        // The last good tree stays; the next read retries.
        onStatus({ loading: false, count: -1, error: "The accessibility tree could not be read." });
      }
      // The next read starts only after this one finished, so slow dumps never pile up.
      if (!stopped && poll) {
        timer = setTimeout(() => void read(), platform === "android" ? ANDROID_AX_POLL_MS : DEVICE_AX_POLL_MS);
      }
    };
    void read();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [hostId, deviceId, platform, grants, poll, refreshKey, onStatus]);

  React.useEffect(
    () => () => {
      setTree({ elements: [], root: null });
      setHovered(null);
    },
    [hostId, deviceId],
  );

  const elements = React.useMemo(
    () => tree.elements.map((element) => ({ ...element, ...axRectToDisplay(element, tree.root, props.screen) })),
    [tree, props.screen],
  );

  React.useEffect(() => {
    const surface = props.screenRef.current;
    if (!surface) return;
    const move = (event: PointerEvent) => {
      const rect = surface.getBoundingClientRect();
      const point = {
        x: (event.clientX - rect.left) / Math.max(1, rect.width),
        y: (event.clientY - rect.top) / Math.max(1, rect.height),
      };
      const hit = hitTestAxElements(elements, point);
      setHovered((current) => (current?.id === hit?.id ? current : hit));
    };
    const leave = () => setHovered(null);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerleave", leave);
    return () => {
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerleave", leave);
    };
  }, [elements, props.screenRef]);

  return (
    <div className="device-ax-overlay" aria-hidden data-count={elements.length}>
      {elements.map((element) => (
        <div
          key={element.id}
          className="device-ax-frame"
          data-hovered={hovered?.id === element.id || undefined}
          style={{
            left: `${element.x * 100}%`,
            top: `${element.y * 100}%`,
            width: `${element.width * 100}%`,
            height: `${element.height * 100}%`,
          }}
        />
      ))}
      {hovered ? <DeviceAxLabel element={elements.find((element) => element.id === hovered.id) ?? hovered} /> : null}
    </div>
  );
}

/** The hovered element's label and role, kept inside the screen. */
export function DeviceAxLabel({ element }: { element: DeviceAxElement }) {
  const below = element.y < 0.08;
  return (
    <div
      className="device-ax-label"
      data-placement={below ? "below" : "above"}
      style={{
        left: `${Math.min(element.x, 0.6) * 100}%`,
        top: `${(below ? element.y + element.height : element.y) * 100}%`,
      }}
    >
      <span className="device-ax-label-text">{element.label || "Unlabeled"}</span>
      {element.role ? <span className="device-ax-label-role">{element.role}</span> : null}
    </div>
  );
}
