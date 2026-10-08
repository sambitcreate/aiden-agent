import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, GripHorizontal, House, PanelRight, RotateCw, Square, X } from "lucide-react";
import { Button, Text } from "./ui";
import { useDeviceStream } from "../lib/use-device-stream";
import {
  DEVICE_SCREEN_CONTAINER_STYLE,
  deviceDisplayRotation,
  fittedScreenStyle,
  rotatedMediaStyle,
} from "../lib/device-display-rotation";
import { useFloatingContainerBounds } from "../lib/use-floating-container-bounds";
import { useDeviceServiceState } from "../lib/use-device-service-state";
import {
  deviceMiniPlayerFrame,
  deviceMiniPlayerGeometry,
  deviceMiniPlayerSource,
  keyboardDeviceMiniPlayer,
  moveDeviceMiniPlayer,
  resizeDeviceMiniPlayer,
  snapDeviceMiniPlayer,
  type DeviceMiniPlayerEdge,
  type DeviceMiniPlayerFrame,
} from "../lib/device-mini-player-layout";
import { deviceTabKey, parseDeviceTabKey } from "../lib/device-tabs";
import {
  deviceWorkspace,
  useChatDeviceTabs,
  useDeviceMiniPlayerGeometry,
  useFloatingDevice,
} from "../lib/device-workspace-store";
import type { DeviceSummary } from "../shared/devices";
import { cn } from "../lib/ui-utils";

const EDGES: ReadonlyArray<{ edge: DeviceMiniPlayerEdge; className: string }> = [
  { edge: "north", className: "inset-x-3 -top-1 h-2 cursor-ns-resize" },
  { edge: "south", className: "inset-x-3 -bottom-1 h-2 cursor-ns-resize" },
  { edge: "west", className: "inset-y-3 -left-1 w-2 cursor-ew-resize" },
  { edge: "east", className: "inset-y-3 -right-1 w-2 cursor-ew-resize" },
  { edge: "northwest", className: "-left-1.5 -top-1.5 size-4 cursor-nwse-resize" },
  { edge: "northeast", className: "-right-1.5 -top-1.5 size-4 cursor-nesw-resize" },
  { edge: "southwest", className: "-bottom-1.5 -left-1.5 size-4 cursor-nesw-resize" },
  { edge: "southeast", className: "-bottom-1.5 -right-1.5 size-4 cursor-nwse-resize" },
];

/** A touch that travels less than this is a click on the handle, not a drag. */
const DRAG_SLOP_PX = 4;

function useDocumentVisible(): boolean {
  const [visible, setVisible] = React.useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export interface DeviceMiniPlayerProps {
  device: DeviceSummary;
  title: string;
  /** Streams only while true. */
  active: boolean;
  onDock(): void;
  onClose(): void;
}

/**
 * A resizable, draggable device player over the chat. Drag the header to
 * move it (it snaps to nearby edges and corners), drag any edge to resize it,
 * or focus the header and use the arrow keys and plus or minus. Escape docks
 * it back into its tab. The screen takes touches and keys like the full viewer.
 */
export function DeviceMiniPlayer({ device, title, active, onDock, onClose }: DeviceMiniPlayerProps) {
  // The chat area in viewport coordinates; the player never leaves it.
  const container = useFloatingContainerBounds();
  const geometry = useDeviceMiniPlayerGeometry();
  const stream = useDeviceStream({ hostId: device.hostId, deviceId: device.id, platform: device.platform, active });
  const android = device.platform === "android";
  // A portrait framebuffer reporting landscape is drawn turned, as in the full viewer.
  const displayRotation = deviceDisplayRotation(device.platform, stream.screen);
  const displayedScreen =
    stream.screen && (displayRotation === 90 || displayRotation === -90)
      ? { width: stream.screen.height, height: stream.screen.width }
      : stream.screen;
  const source = deviceMiniPlayerSource(device.kind, displayedScreen);
  const mediaStyle = rotatedMediaStyle(displayRotation);
  const stored = deviceMiniPlayerFrame({ source, container, geometry });
  const [live, setLive] = React.useState<DeviceMiniPlayerFrame | null>(null);
  const frame = live ?? stored;
  const gesture = React.useRef<{
    pointerId: number;
    x: number;
    y: number;
    frame: DeviceMiniPlayerFrame;
    edge: DeviceMiniPlayerEdge | null;
    moved: boolean;
  } | null>(null);
  const titleId = React.useId();
  const hintId = React.useId();
  const streaming = stream.status === "streaming";

  const commit = (next: DeviceMiniPlayerFrame) => {
    deviceWorkspace.setGeometry(deviceMiniPlayerGeometry(next));
  };
  const begin = (event: React.PointerEvent<HTMLElement>, edge: DeviceMiniPlayerEdge | null) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, frame, edge, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  };
  const move = (event: React.PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const delta = { x: event.clientX - start.x, y: event.clientY - start.y };
    if (!start.moved && Math.hypot(delta.x, delta.y) < DRAG_SLOP_PX) return;
    start.moved = true;
    setLive(
      start.edge
        ? resizeDeviceMiniPlayer({ start: start.frame, edge: start.edge, delta, source, container })
        : moveDeviceMiniPlayer({ start: start.frame, delta, source, container }),
    );
  };
  const end = (event: React.PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (start?.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (start.moved && live) commit(start.edge ? live : snapDeviceMiniPlayer(live, container));
    setLive(null);
  };
  const onHandleKey = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.altKey || event.ctrlKey) return;
    const next = keyboardDeviceMiniPlayer({ key: event.key, shiftKey: event.shiftKey, frame, source, container });
    if (!next) return;
    event.preventDefault();
    commit(next);
  };

  const hidden = container.width <= 0 || container.height <= 0;
  return (
    <section
      className={cn(
        "device-mini-player fixed z-[48] flex min-h-0 min-w-0 flex-col rounded-sheet bg-popover text-primary shadow-dialog",
        live ? "transition-none" : "device-mini-player-settle",
      )}
      data-device-mini-player={deviceTabKey({ hostId: device.hostId, deviceId: device.id })}
      data-dragging={live ? "true" : undefined}
      aria-labelledby={titleId}
      aria-describedby={hintId}
      aria-roledescription="floating device"
      style={{
        visibility: hidden ? "hidden" : undefined,
        left: container.x + frame.x,
        top: container.y + frame.y,
        width: frame.width,
        height: frame.height,
      }}
      onKeyDown={(event) => {
        // The screen sends its keys to the device; everywhere else Escape docks.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onDock();
      }}
    >
      <span id={hintId} className="sr-only">
        Drag the header or use the arrow keys on it to move the player, plus or minus to resize, and Escape to put it back in its tab.
      </span>
      <div
        className="flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-1 rounded-t-sheet pl-2 pr-1 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring active:cursor-grabbing"
        role="group"
        aria-label={`Move ${title}`}
        tabIndex={0}
        onPointerDown={(event) => begin(event, null)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onHandleKey}
      >
        <GripHorizontal aria-hidden className="size-3.5 shrink-0 text-tertiary" />
        <Text id={titleId} variant="small-strong" className="min-w-0 flex-1 truncate">
          {title}
        </Text>
        {android ? (
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label="Back"
            title="Back"
            disabled={!streaming}
            onClick={() => stream.client()?.pressButton("back")}
          >
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}
        <Button
          variant="transparent"
          size="small"
          iconOnly
          aria-label="Home"
          title="Home"
          disabled={!streaming}
          onClick={() => stream.client()?.pressButton("home")}
        >
          <House aria-hidden />
        </Button>
        {android ? (
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label="Recents"
            title="Recents"
            disabled={!streaming}
            onClick={() => stream.client()?.pressButton("recents")}
          >
            <Square aria-hidden />
          </Button>
        ) : (
          // Android rotates through the emulator's sensor action, which the full viewer offers.
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label="Rotate"
            title="Rotate"
            disabled={!streaming}
            onClick={() => stream.client()?.rotate()}
          >
            <RotateCw aria-hidden />
          </Button>
        )}
        <Button variant="transparent" size="small" iconOnly aria-label="Dock device in its tab" title="Dock in tab" onClick={onDock}>
          <PanelRight aria-hidden />
        </Button>
        <Button variant="transparent" size="small" iconOnly aria-label="Close floating device" title="Close floating device" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-b-sheet bg-well"
        style={DEVICE_SCREEN_CONTAINER_STYLE}
      >
        <div
          className="device-viewer-screen device-mini-player-screen"
          data-typing-surface="device"
          style={{ ...DEVICE_SCREEN_CONTAINER_STYLE, ...fittedScreenStyle(source.width / source.height) }}
          tabIndex={0}
          role="application"
          aria-roledescription="simulator screen"
          aria-label={`${title} screen. Click or drag to touch; type to send keys while focused.`}
          onPointerDown={stream.pointer("begin")}
          onPointerMove={stream.pointer("move")}
          onPointerUp={stream.pointer("end")}
          onPointerCancel={stream.pointer("end")}
          onKeyDown={stream.key("down")}
          onKeyUp={stream.key("up")}
          onBlur={stream.releaseKeys}
          onContextMenu={(event) => event.preventDefault()}
        >
          <canvas ref={stream.canvasRef} hidden={Boolean(stream.mjpegUrl)} style={mediaStyle} aria-hidden />
          {stream.mjpegUrl ? <img ref={stream.attachImage} alt="" draggable={false} style={mediaStyle} /> : null}
          {stream.status === "error" ? (
            <div className="device-viewer-overlay">
              <Text variant="small" color="secondary">
                {stream.detail ?? "The simulator stream stopped."}
              </Text>
              <Button size="small" variant="muted" onClick={stream.reconnect}>
                Reconnect
              </Button>
            </div>
          ) : null}
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {streaming ? "Live" : stream.status === "error" ? "Disconnected" : "Connecting…"}
        </span>
      </div>
      {EDGES.map(({ edge, className }) => (
        <div
          key={edge}
          role="presentation"
          data-device-mini-player-resize={edge}
          className={cn("absolute z-10 touch-none", className)}
          onPointerDown={(event) => begin(event, edge)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </section>
  );
}

/**
 * Renders the device floating over this chat, if any. It follows the chat's
 * device session: when the session ends, the player goes away with it.
 */
export function DeviceMiniPlayerHost({
  chatId,
  enabled,
  onDock,
}: {
  chatId: string | null;
  enabled: boolean;
  /** Puts the device back in its Environment tab and shows that tab. */
  onDock(chatId: string, key: string): void;
}) {
  const floatingKey = useFloatingDevice(chatId);
  const tabs = useChatDeviceTabs(chatId);
  const live = enabled && Boolean(chatId && floatingKey);
  const state = useDeviceServiceState(live);
  const visible = useDocumentVisible();
  const target = floatingKey ? parseDeviceTabKey(floatingKey) : null;
  const session =
    chatId && target
      ? state?.sessions.find(
          (candidate) =>
            candidate.chatId === chatId &&
            candidate.hostId === target.hostId &&
            candidate.deviceId === target.deviceId,
        )
      : undefined;
  const device = target
    ? state?.devices.find((candidate) => candidate.hostId === target.hostId && candidate.id === target.deviceId)
    : undefined;
  const ended = Boolean(state && chatId && floatingKey && (!session || state.hostStatus === "disabled"));
  React.useEffect(() => {
    if (ended && chatId) deviceWorkspace.setFloating(chatId, null);
  }, [chatId, ended]);
  if (!live || !chatId || !floatingKey || !session || !device) return null;
  return createPortal(
    <DeviceMiniPlayer
      key={floatingKey}
      device={device}
      title={tabs.titles[floatingKey] ?? device.name}
      active={visible}
      onDock={() => onDock(chatId, floatingKey)}
      onClose={() => deviceWorkspace.setFloating(chatId, null)}
    />,
    document.body,
  );
}
