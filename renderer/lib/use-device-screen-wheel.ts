// Wheel events over a streamed screen scroll the device, not the page around
// it. React's wheel listener is passive, so this one is native.

import * as React from "react";
import type { DeviceStreamClient } from "./device-stream";

/** One wheel line, in pixels, for wheels that report lines rather than pixels. */
const WHEEL_LINE_PX = 16;

export function useDeviceScreenWheel(
  screenRef: React.RefObject<HTMLElement | null>,
  client: () => DeviceStreamClient | null,
): void {
  const clientRef = React.useRef(client);
  clientRef.current = client;
  React.useEffect(() => {
    const element = screenRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? rect.height : 1;
      const clamp = (value: number) => Math.min(1, Math.max(0, value));
      clientRef
        .current()
        ?.sendScroll(
          clamp((event.clientX - rect.left) / Math.max(1, rect.width)),
          clamp((event.clientY - rect.top) / Math.max(1, rect.height)),
          event.deltaX * scale,
          event.deltaY * scale,
        );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [screenRef]);
}
