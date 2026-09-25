import * as React from "react";
import {
  ALargeSmall,
  Box,
  Camera,
  House,
  Lock,
  Moon,
  Power,
  Rotate3d,
  RotateCw,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Text,
  toast,
} from "./ui";
import { devicesApi } from "../lib/ipc";
import {
  createCanvasFrameSink,
  createDeviceStreamClient,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "../lib/device-stream";
import type { DuoControlState } from "../lib/device-duo-control";
import { useDeviceControls } from "../lib/device-controls";
import { COMPOSER_IMAGE_UNAVAILABLE, composerImageAttach } from "../lib/composer-attach";
import {
  frameBlocker,
  frameBlockerLabel,
  readFramePreference,
  writeFramePreference,
  type DeviceFramePreference,
} from "../lib/device-3d/frame-mode";
import { resolveDeviceShape } from "../lib/device-3d/shape-profile";
import { DeviceDuoControls } from "./device-duo-controls";
import { DevicePhoneViewport } from "./device-phone-viewport";
import { DEVICE_TEXT_SIZE_OPTIONS, DeviceToolsPanel } from "./device-tools-panel";
import type { DeviceSession, DeviceStreamGrant, DeviceSummary } from "../shared/devices";

/** A burst of rejected grants means the proxy is refusing us, not that one grant expired. */
const MAX_GRANT_RENEWALS_PER_MINUTE = 3;

export interface DeviceViewerProps {
  chatId: string;
  session: DeviceSession;
  device: DeviceSummary;
  /** Presented, selected, and the document is visible. The stream runs only while true. */
  active: boolean;
  compact: boolean;
  onClose(shutdown: boolean): void;
}

type ViewerStatus = DeviceStreamStatus | "idle";

export function deviceStatusLabel(status: ViewerStatus, inputConnected: boolean): string {
  if (status === "streaming") return inputConnected ? "Live" : "Live, input reconnecting…";
  if (status === "error") return "Disconnected";
  return "Connecting…";
}

function defaultAspect(device: DeviceSummary): number {
  return device.kind === "ipad" ? 820 / 1180 : 390 / 844;
}

/** Normalized 0..1 point inside the displayed frame. */
function framePoint(element: HTMLElement, event: React.PointerEvent): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return {
    x: clamp((event.clientX - rect.left) / Math.max(1, rect.width)),
    y: clamp((event.clientY - rect.top) / Math.max(1, rect.height)),
  };
}

export function DeviceViewer({ chatId, session, device, active, compact, onClose }: DeviceViewerProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const clientRef = React.useRef<DeviceStreamClient | null>(null);
  const renewalsRef = React.useRef<number[]>([]);
  const [grant, setGrant] = React.useState<DeviceStreamGrant | null>(null);
  const [status, setStatus] = React.useState<ViewerStatus>("idle");
  const [detail, setDetail] = React.useState<string | undefined>();
  const [inputConnected, setInputConnected] = React.useState(false);
  const [screen, setScreen] = React.useState<DeviceScreenSize | null>(null);
  const [mjpegUrl, setMjpegUrl] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = React.useState(false);
  const [framePreference, setFramePreference] = React.useState<DeviceFramePreference>(() => readFramePreference());
  const [webglUnavailable, setWebglUnavailable] = React.useState(false);
  const frameListenerRef = React.useRef<(() => void) | null>(null);
  const [resetPose, setResetPose] = React.useState<(() => void) | null>(null);
  const [duoState, setDuoState] = React.useState<DuoControlState>({
    pending: false,
    requested: null,
    error: null,
  });
  // The frontmost-app feed runs only while the drawer is open.
  const controls = useDeviceControls({
    hostId: session.hostId,
    deviceId: session.deviceId,
    grant: toolsOpen ? grant : null,
    visible: active,
  });
  const appearance = controls.settings?.appearance;

  const fail = React.useCallback((message: string) => {
    setStatus("error");
    setDetail(message);
  }, []);

  // Grants are minted only while the tab is active; a renewal bumps `attempt`.
  React.useEffect(() => {
    if (!active) return;
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
    // Frames always land in the flat canvas; a mounted 3D frame samples it as a texture.
    const canvasSink = createCanvasFrameSink(canvas);
    const client = createDeviceStreamClient(
      { hostId: session.hostId, deviceId: session.deviceId, grant },
      {
        present(source, width, height) {
          const presented = canvasSink.present(source, width, height);
          if (presented) frameListenerRef.current?.();
          return presented;
        },
      },
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
        onInputConnected: (connected) => setInputConnected(connected),
        onDuoControl: setDuoState,
      },
    );
    clientRef.current = client;
    client.start();
    return () => {
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
      setInputConnected(false);
      setMjpegUrl(null);
    };
  }, [active, grant, session.hostId, session.deviceId, fail]);

  // The fallback `<img>` mounts only after the running client asked for it,
  // and unmounts when that client stops, so the current client owns it.
  const attachImage = React.useCallback((image: HTMLImageElement | null) => {
    clientRef.current?.setMjpegImage(image);
  }, []);

  const run = async (label: string, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    try {
      await task();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not ${label}.`);
    } finally {
      setBusy(null);
    }
  };

  // With the drawer closed, rail failures surface as toasts; the drawer shows them inline.
  React.useEffect(() => {
    if (controls.error && !toolsOpen) toast.error(controls.error);
  }, [controls.error, toolsOpen]);
  const toggleAppearance = () =>
    void controls.act({ type: "setAppearance", value: appearance === "dark" ? "light" : "dark" });

  const screenshotToChat = () =>
    run("take a screenshot", async () => {
      const png = await devicesApi.screenshot({ hostId: session.hostId, deviceId: session.deviceId });
      const file = new File([png as BlobPart], `${device.name} screenshot.png`, { type: "image/png" });
      if (!composerImageAttach.deliver(chatId, [file])) toast.info(COMPOSER_IMAGE_UNAVAILABLE);
    });

  const pointer = (phase: "begin" | "move" | "end") => (event: React.PointerEvent<HTMLElement>) => {
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
  };

  // Tab and Shift+Tab stay with the app so keyboard users can always leave the device.
  const key = (phase: "down" | "up") => (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.code === "Tab" || event.metaKey) return;
    event.preventDefault();
    if (phase === "down" && event.repeat) return;
    clientRef.current?.sendKey(event.code, phase);
  };

  const aspect = screen ? screen.width / screen.height : defaultAspect(device);
  const blocker = frameBlocker({
    mjpeg: Boolean(mjpegUrl),
    hinged: Boolean(screen?.supportsHingeAngle),
    webglUnavailable,
  });
  const frame3d = active && framePreference === "3d" && blocker === null;
  const profile = React.useMemo(
    () =>
      resolveDeviceShape(
        device.kind,
        screen ? Math.min(screen.width, screen.height) / Math.max(1, Math.max(screen.width, screen.height)) : NaN,
      ),
    [device.kind, screen],
  );
  const onFrameListener = React.useCallback((listener: (() => void) | null) => {
    frameListenerRef.current = listener;
  }, []);
  const onResetReady = React.useCallback((reset: (() => void) | null) => {
    setResetPose(() => reset);
  }, []);
  const onFrameUnavailable = React.useCallback(() => {
    setWebglUnavailable(true);
    toast.info("The 3D frame is unavailable, so the flat screen is shown.");
  }, []);
  const touch3d = React.useCallback((phase: "begin" | "move" | "end", point: { x: number; y: number }) => {
    clientRef.current?.sendTouch(phase, point.x, point.y);
  }, []);
  const errorOverlay =
    status === "error" ? (
      <div className="device-viewer-overlay">
        <Text variant="small" color="secondary">
          {detail ?? "The simulator stream stopped."}
        </Text>
        <Button
          size="small"
          variant="muted"
          onClick={() => {
            renewalsRef.current = [];
            setAttempt((value) => value + 1);
          }}
        >
          Reconnect
        </Button>
      </div>
    ) : null;
  const toggleFrame = () => {
    const next = framePreference === "3d" ? "flat" : "3d";
    setFramePreference(next);
    writeFramePreference(next);
  };
  const label = deviceStatusLabel(status, inputConnected);
  const railButton = (
    name: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <Button
      variant="transparent"
      size="small"
      aria-label={name}
      title={name}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
  const streaming = status === "streaming";

  return (
    <section aria-labelledby="device-viewer-title" className="device-viewer">
      <header className="device-viewer-header">
        <div className="min-w-0">
          <Text id="device-viewer-title" variant="small-strong" className="block truncate">
            {device.name}
          </Text>
          <Text variant="small" color="secondary" className={compact ? "sr-only" : "block truncate"}>
            {device.version}
          </Text>
        </div>
        <span className="device-viewer-status" data-status={status} role="status" aria-live="polite">
          {label}
        </span>
      </header>
      <div className="device-viewer-stage" data-frame={frame3d ? "3d" : "flat"}>
        {frame3d ? (
          <div
            className="device-viewer-3d"
            tabIndex={0}
            role="application"
            aria-roledescription="simulator"
            aria-label={`${device.name} in a 3D frame. Drag the screen to touch, or drag around the device to turn it; type to send keys while focused.`}
            onKeyDown={key("down")}
            onKeyUp={key("up")}
          >
            <DevicePhoneViewport
              source={canvasRef}
              screen={screen}
              profile={profile}
              onFrameListener={onFrameListener}
              onResetReady={onResetReady}
              touch={touch3d}
              onUnavailable={onFrameUnavailable}
            />
            {errorOverlay}
          </div>
        ) : null}
        <div
          className="device-viewer-screen"
          hidden={frame3d}
          style={{ aspectRatio: String(aspect) }}
          tabIndex={0}
          role="application"
          aria-roledescription="simulator screen"
          aria-label={`${device.name} screen. Click or drag to touch; type to send keys while focused.`}
          onPointerDown={pointer("begin")}
          onPointerMove={pointer("move")}
          onPointerUp={pointer("end")}
          onPointerCancel={pointer("end")}
          onKeyDown={key("down")}
          onKeyUp={key("up")}
          onContextMenu={(event) => event.preventDefault()}
        >
          <canvas ref={canvasRef} hidden={Boolean(mjpegUrl)} aria-hidden />
          {mjpegUrl ? <img ref={attachImage} alt="" draggable={false} /> : null}
          {frame3d ? null : errorOverlay}
        </div>
        {screen?.supportsHingeAngle ? (
          <DeviceDuoControls
            screen={screen}
            state={duoState}
            enabled={streaming && inputConnected}
            onCommand={(command) => clientRef.current?.controlDuo(command)}
          />
        ) : null}
      </div>
      <div className="device-viewer-rail" role="toolbar" aria-label="Simulator controls">
        {railButton("Home", <House aria-hidden />, () => clientRef.current?.pressButton("home"), !streaming)}
        {railButton("Lock", <Lock aria-hidden />, () => clientRef.current?.pressButton("lock"), !streaming)}
        {railButton("Rotate", <RotateCw aria-hidden />, () => clientRef.current?.rotate(), !streaming)}
        {railButton(
          appearance === "dark" ? "Switch to light appearance" : "Switch to dark appearance",
          appearance === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />,
          toggleAppearance,
          controls.disabled,
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="transparent"
              size="small"
              aria-label="Text size"
              title="Text size"
              disabled={controls.disabled || !controls.settings?.textSize}
            >
              <ALargeSmall aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuLabel>Text size</DropdownMenuLabel>
            {DEVICE_TEXT_SIZE_OPTIONS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={controls.settings?.textSize === option.value}
                onSelect={() => {
                  if (controls.settings?.textSize !== option.value) {
                    void controls.act({ type: "setTextSize", value: option.value });
                  }
                }}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {railButton("Screenshot to chat", <Camera aria-hidden />, screenshotToChat, busy !== null)}
        <Button
          variant={framePreference === "3d" && blocker === null ? "muted" : "transparent"}
          size="small"
          aria-label="3D frame"
          title={frameBlockerLabel(blocker)}
          aria-pressed={framePreference === "3d" && blocker === null}
          disabled={blocker !== null}
          onClick={toggleFrame}
        >
          <Box aria-hidden />
        </Button>
        {frame3d && resetPose ? railButton("Reset 3D view", <Rotate3d aria-hidden />, resetPose) : null}
        <Button
          variant={toolsOpen ? "muted" : "transparent"}
          size="small"
          aria-label="Device tools"
          title="Device tools"
          aria-pressed={toolsOpen}
          aria-expanded={toolsOpen}
          aria-controls={toolsOpen ? "device-tools" : undefined}
          onClick={() => setToolsOpen((open) => !open)}
        >
          <SlidersHorizontal aria-hidden />
        </Button>
        <span className="flex-1" />
        {railButton("Shut down simulator", <Power aria-hidden />, () => onClose(true))}
        {railButton("Close simulator", <X aria-hidden />, () => onClose(false))}
      </div>
      {toolsOpen ? (
        <div id="device-tools" className="device-viewer-tools">
          <DeviceToolsPanel controls={controls} onClose={() => setToolsOpen(false)} />
        </div>
      ) : null}
    </section>
  );
}
