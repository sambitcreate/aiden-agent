import * as React from "react";
import {
  ALargeSmall,
  ArrowLeft,
  Box,
  House,
  Lock,
  Moon,
  PictureInPicture2,
  Power,
  Rotate3d,
  RotateCw,
  SlidersHorizontal,
  Smartphone,
  Square,
  Sun,
  X,
} from "lucide-react";
import {
  AlertDialog,
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
import type { DuoCommand, DuoControlState } from "../lib/device-duo-control";
import { useDeviceControls } from "../lib/device-controls";
import { COMPOSER_IMAGE_UNAVAILABLE, composerImageAttach } from "../lib/composer-attach";
import {
  frameBlocker,
  frameBlockerLabel,
  readFramePreference,
  writeFramePreference,
  type DeviceFramePreference,
} from "../lib/device-3d/frame-mode";
import { isDuoDevice, resolveDeviceModelId } from "../lib/device-3d/model-registry";
import { resolveDeviceShape } from "../lib/device-3d/shape-profile";
import { DeviceDuoControls } from "./device-duo-controls";
import { DeviceDuoViewport } from "./device-duo-viewport";
import { DeviceAndroidFoldControls } from "./device-android-fold-controls";
import { useAndroidFold } from "../lib/device-fold";
import { DevicePhoneViewport } from "./device-phone-viewport";
import { DEVICE_ORIENTATION_OPTIONS, DEVICE_TEXT_SIZE_OPTIONS, DeviceToolsPanel } from "./device-tools-panel";
import { DeviceAxOverlay, type DeviceAxStatus } from "./device-ax-overlay";
import { pasteToDeviceWithFeedback } from "./device-clipboard-controls";
import { DeviceFeatureSections } from "./device-feature-sections";
import { DeviceMultiTouchLayer } from "./device-multitouch-layer";
import { DeviceRecordControl } from "./device-record-control";
import {
  DeviceScreenshotControl,
  saveFramedScreenshotWithFeedback,
  saveScreenshotWithFeedback,
} from "./device-screenshot-control";
import { createDeviceGrantSource } from "../lib/device-grant";
import type { MultiTouchSink } from "../lib/device-multitouch";
import { deviceFeatureCapabilities, type DeviceFeatureTarget } from "../shared/device-features";
import { LOCAL_DEVICE_HOST_ID, type DeviceSession, type DeviceStreamGrant, type DeviceSummary } from "../shared/devices";

/** A burst of rejected grants means the proxy is refusing us, not that one grant expired. */
const MAX_GRANT_RENEWALS_PER_MINUTE = 3;
/** How long an Android encoder restart may keep the last frame before the viewer says it is waiting. */
export const ANDROID_RESTART_NOTICE_MS = 2_000;

export interface DeviceViewerProps {
  chatId: string;
  session: DeviceSession;
  device: DeviceSummary;
  /** Presented, selected, and the document is visible. The stream runs only while true. */
  active: boolean;
  compact: boolean;
  onClose(shutdown: boolean): void;
  /** Pops the device out to float over the chat. */
  onFloat?(): void;
}

type ViewerStatus = DeviceStreamStatus | "idle";

export function deviceStatusLabel(status: ViewerStatus, inputConnected: boolean): string {
  if (status === "streaming") return inputConnected ? "Live" : "Live, input reconnecting…";
  if (status === "error") return "Disconnected";
  return "Connecting…";
}

function defaultAspect(device: DeviceSummary): number {
  if (device.platform === "android") return 1080 / 2400;
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

export function DeviceViewer({ chatId, session, device, active, compact, onClose, onFloat }: DeviceViewerProps) {
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
  const [shutdownOpen, setShutdownOpen] = React.useState(false);
  const toolsTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const toolsRef = React.useRef<HTMLDivElement | null>(null);
  const frameBlockerId = React.useId();
  const [framePreference, setFramePreference] = React.useState<DeviceFramePreference>(() => readFramePreference());
  const [frameFailed, setFrameFailed] = React.useState(false);
  /** Sticky once a frame lands, so the 3D frame never loads for a stream that turns out flat-only. */
  const [framed, setFramed] = React.useState(false);
  const framedRef = React.useRef(false);
  const frameListenerRef = React.useRef<(() => void) | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  /** Keys sent down and not yet up, released whenever the focused surface goes away. */
  const pressedKeysRef = React.useRef(new Set<string>());
  const stageFocusedRef = React.useRef(false);
  const [resetPose, setResetPose] = React.useState<(() => void) | null>(null);
  /** Draws the framed device while the 3D view is mounted. */
  const [captureFramed, setCaptureFramed] = React.useState<(() => Promise<Blob | null>) | null>(null);
  /** Cancels a captured 3D touch or pinch before a command moves the device under it. */
  const cancelFrameInputRef = React.useRef<(() => void) | null>(null);
  const screenRef = React.useRef<HTMLDivElement | null>(null);
  // Device power features: accessibility overlay, multi-touch, clipboard, recording, erase.
  const [axOverlay, setAxOverlay] = React.useState(false);
  const [axStatus, setAxStatus] = React.useState<DeviceAxStatus | null>(null);
  const [axRefresh, setAxRefresh] = React.useState(0);
  const featureGrants = React.useMemo(() => createDeviceGrantSource(() => devicesApi.streamGrant()), []);
  const featureTarget = React.useMemo<DeviceFeatureTarget>(
    () => ({ platform: device.platform, hostId: session.hostId, deviceId: session.deviceId }),
    [device.platform, session.hostId, session.deviceId],
  );
  const localDevice = session.hostId === LOCAL_DEVICE_HOST_ID;
  // Each power feature shows only where it works for this platform and host.
  const capabilities = React.useMemo(
    () => deviceFeatureCapabilities(device.platform, { local: localDevice }),
    [device.platform, localDevice],
  );
  const multiTouchSink = React.useMemo<MultiTouchSink>(
    () => ({ sendMultiTouch: (phase, first, second) => clientRef.current?.sendMultiTouch(phase, first, second) }),
    [],
  );
  const sendDeviceKey = React.useCallback(
    (code: string, phase: "down" | "up") => clientRef.current?.sendKey(code, phase),
    [],
  );
  const [duoState, setDuoState] = React.useState<DuoControlState>({
    pending: false,
    requested: null,
    error: null,
  });
  const android = device.platform === "android";
  const noun = android ? "emulator" : "simulator";
  // The frontmost-app feed runs only while the drawer is open.
  const controls = useDeviceControls({
    hostId: session.hostId,
    deviceId: session.deviceId,
    platform: device.platform,
    grant: toolsOpen ? grant : null,
    visible: active,
  });
  // Android foldables: followed while the stream is live, so the flat controls and the 3D frame share it.
  const fold = useAndroidFold({
    hostId: session.hostId,
    deviceId: session.deviceId,
    enabled: android && active && status === "streaming" && inputConnected,
    screenKey: screen ? `${screen.width}x${screen.height}` : null,
    mintGrant: devicesApi.streamGrant,
  });
  // serve-emu restarts its encoder when a fold or rotation changes the screen size; the last frame stays up.
  const restarting = android && status === "connecting" && inputConnected && screen !== null;
  const [restartNotice, setRestartNotice] = React.useState(false);
  React.useEffect(() => {
    if (!restarting) {
      setRestartNotice(false);
      return;
    }
    const timer = window.setTimeout(() => setRestartNotice(true), ANDROID_RESTART_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [restarting]);
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
        if (current) fail(error instanceof Error ? error.message : `Could not reach the ${noun}.`);
      });
    return () => {
      current = false;
      setGrant(null);
    };
  }, [active, attempt, fail, noun]);

  React.useEffect(() => {
    if (!active || !grant) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Frames always land in the flat canvas; a mounted 3D frame samples it as a texture.
    const canvasSink = createCanvasFrameSink(canvas);
    const client = createDeviceStreamClient(
      { hostId: session.hostId, deviceId: session.deviceId, platform: device.platform, grant },
      {
        present(source, width, height) {
          const presented = canvasSink.present(source, width, height);
          if (presented) {
            frameListenerRef.current?.();
            if (!framedRef.current) {
              framedRef.current = true;
              setFramed(true);
            }
          }
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
            fail(`The ${noun} stream refused access. Reconnect to try again.`);
            return;
          }
          renewalsRef.current.push(now);
          setAttempt((value) => value + 1);
        },
        onMjpegFallback: setMjpegUrl,
        onInputConnected: (connected) => setInputConnected(connected),
        onDuoControl: setDuoState,
        onDuoUnavailable: () => onFrameUnavailableRef.current(),
      },
    );
    clientRef.current = client;
    client.start();
    return () => {
      for (const code of pressedKeysRef.current) client.sendKey(code, "up");
      pressedKeysRef.current.clear();
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
      setInputConnected(false);
      setMjpegUrl(null);
    };
  }, [active, grant, session.hostId, session.deviceId, device.platform, noun, fail]);

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
  // Keys pressed on a control inside the surface (the Reconnect button) stay with that control.
  const key = (phase: "down" | "up") => (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.code === "Tab" || event.metaKey) return;
    event.preventDefault();
    if (phase === "down" && event.repeat) return;
    if (phase === "down") pressedKeysRef.current.add(event.code);
    else pressedKeysRef.current.delete(event.code);
    clientRef.current?.sendKey(event.code, phase, { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey });
  };
  const releaseKeys = React.useCallback(() => {
    for (const code of pressedKeysRef.current) clientRef.current?.sendKey(code, "up");
    pressedKeysRef.current.clear();
  }, []);

  const aspect = screen ? screen.width / screen.height : defaultAspect(device);
  const model = resolveDeviceModelId(device.platform, device.name);
  const duo = isDuoDevice(device.platform, device.name, screen);
  const blocker = frameBlocker({
    mjpeg: Boolean(mjpegUrl),
    // A Duo whose hub reports no hinge fields cannot drive the articulated body.
    duoWithoutHinge: duo && screen !== null && !screen.supportsHingeAngle,
    frameFailed,
  });
  // Element frames draw over the flat screen, so the 3D frame steps aside while they show.
  const frame3d = active && framePreference === "3d" && blocker === null && screen !== null && framed && !axOverlay;
  // Switching surfaces unmounts or hides the focused one: release its keys and keep focus on the device.
  React.useLayoutEffect(() => {
    releaseKeys();
    const stage = stageRef.current;
    if (!stage || !stageFocusedRef.current) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && stage.contains(focused)) return;
    stage
      .querySelector<HTMLElement>(frame3d ? ".device-viewer-3d" : ".device-viewer-screen")
      ?.focus({ preventScroll: true });
  }, [frame3d, releaseKeys]);
  const profile = React.useMemo(
    () =>
      resolveDeviceShape({
        platform: device.platform,
        kind: device.kind,
        name: device.name,
        portraitAspect: screen
          ? Math.min(screen.width, screen.height) / Math.max(1, Math.max(screen.width, screen.height))
          : Number.NaN,
      }),
    [device.platform, device.kind, device.name, screen],
  );
  const onFrameListener = React.useCallback((listener: (() => void) | null) => {
    frameListenerRef.current = listener;
  }, []);
  const onResetReady = React.useCallback((reset: (() => void) | null) => {
    setResetPose(() => reset);
  }, []);
  const onCaptureReady = React.useCallback((capture: (() => Promise<Blob | null>) | null) => {
    setCaptureFramed(() => capture);
  }, []);
  const frameFailedRef = React.useRef(false);
  const onFrameUnavailable = React.useCallback(() => {
    // One fallback, one toast, however many parts of the 3D view report it.
    if (frameFailedRef.current) return;
    frameFailedRef.current = true;
    setFrameFailed(true);
    toast.info("The 3D view is unavailable, so the flat screen is shown.");
  }, []);
  const onFrameUnavailableRef = React.useRef(onFrameUnavailable);
  onFrameUnavailableRef.current = onFrameUnavailable;
  const onFrameInputCancel = React.useCallback((cancel: (() => void) | null) => {
    cancelFrameInputRef.current = cancel;
  }, []);
  const duoCommand = (command: DuoCommand) => {
    cancelFrameInputRef.current?.();
    clientRef.current?.controlDuo(command);
  };
  const restoreView = () => {
    // A slab device rests upright; the Duo's own reset asks for the orientation its view needs.
    if (!duo && screen && screen.orientation !== "portrait") clientRef.current?.setOrientation("portrait");
    resetPose?.();
  };
  const touch3d = React.useCallback((phase: "begin" | "move" | "end", point: { x: number; y: number }) => {
    clientRef.current?.sendTouch(phase, point.x, point.y);
  }, []);
  const errorOverlay =
    status === "error" ? (
      <div className="device-viewer-overlay">
        <Text variant="small" color="secondary">
          {detail ?? `The ${noun} stream stopped.`}
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
  React.useEffect(() => {
    if (!toolsOpen) return;
    toolsRef.current
      ?.querySelector<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")
      ?.focus();
  }, [toolsOpen]);
  const closeTools = () => {
    setToolsOpen(false);
    toolsTriggerRef.current?.focus();
  };
  const chooseFrame = (next: DeviceFramePreference) => {
    if (next === "3d" && blocker !== null) return;
    setFramePreference(next);
    writeFramePreference(next);
  };
  const showing3d = framePreference === "3d" && blocker === null;
  const label = deviceStatusLabel(status, inputConnected);
  const reconnect = () => {
    renewalsRef.current = [];
    setAttempt((value) => value + 1);
  };
  const pasteShortcut = React.useCallback(
    () => void pasteToDeviceWithFeedback(featureTarget, sendDeviceKey),
    [featureTarget, sendDeviceKey],
  );
  const railButton = (
    name: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled = false,
  ) => (
    <Button
      variant="transparent"
      size="small"
      iconOnly
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
      <div
        ref={stageRef}
        className="device-viewer-stage"
        data-frame={frame3d ? "3d" : "flat"}
        onFocus={() => {
          stageFocusedRef.current = true;
        }}
        onBlur={(event) => {
          releaseKeys();
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          // A surface that is removed or hidden while focused loses focus to nothing; the switch refocuses.
          const target = event.target;
          if (!target.isConnected || target.closest("[hidden]")) return;
          stageFocusedRef.current = false;
        }}
      >
        {frame3d ? (
          <div
            className="device-viewer-3d"
            // Keys typed here belong to the device, never the chat composer.
            data-typing-surface="device"
            tabIndex={0}
            role="application"
            aria-roledescription={noun}
            aria-label={
              duo
                ? `${device.name} in 3D. Drag a display to touch, drag around the device or swipe with two fingers to turn it, and pinch over it to open or close the hinge; type to send keys while focused.`
                : `${device.name} in 3D. Drag the screen to touch, drag around the device or swipe with two fingers to turn it, and pinch to zoom; type to send keys while focused.`
            }
            onKeyDown={key("down")}
            onKeyUp={key("up")}
          >
            {duo ? (
              <DeviceDuoViewport
                source={canvasRef}
                client={clientRef}
                screen={screen}
                hingePreview={duoState.requested?.control === "angle" ? duoState.requested.value : null}
                controlError={duoState.error}
                onFrameListener={onFrameListener}
                onResetReady={onResetReady}
                onCaptureReady={onCaptureReady}
                onInputCancel={onFrameInputCancel}
                onUnavailable={onFrameUnavailable}
              />
            ) : (
              <DevicePhoneViewport
                source={canvasRef}
                screen={screen}
                profile={profile}
                model={model}
                // An Android foldable's hinge, moving ahead of a pending Fold or Unfold.
                foldAngle={android ? fold.angle : null}
                onFrameListener={onFrameListener}
                onResetReady={onResetReady}
                onCaptureReady={onCaptureReady}
                touch={touch3d}
                onUnavailable={onFrameUnavailable}
              />
            )}
            {errorOverlay}
          </div>
        ) : null}
        <div
          ref={screenRef}
          className="device-viewer-screen"
          data-typing-surface="device"
          hidden={frame3d}
          style={{ aspectRatio: String(aspect) }}
          tabIndex={0}
          role="application"
          aria-roledescription={`${noun} screen`}
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
          {capabilities.axOverlay && axOverlay && active && !frame3d ? (
            <DeviceAxOverlay
              hostId={session.hostId}
              deviceId={session.deviceId}
              platform={device.platform}
              grants={featureGrants}
              screen={screen}
              screenRef={screenRef}
              poll={localDevice}
              refreshKey={axRefresh}
              onStatus={setAxStatus}
            />
          ) : null}
          <DeviceMultiTouchLayer
            screenRef={screenRef}
            sink={multiTouchSink}
            enabled={capabilities.multiTouch && active && !frame3d && streaming && inputConnected}
            onPaste={capabilities.clipboardPaste ? pasteShortcut : undefined}
          />
          {frame3d ? null : errorOverlay}
          {restartNotice && !frame3d ? (
            <span className="device-viewer-notice" role="status">
              Waiting for device video…
            </span>
          ) : null}
        </div>
        {android ? (
          <DeviceAndroidFoldControls fold={fold} enabled={streaming && inputConnected} />
        ) : null}
        {screen?.supportsHingeAngle ? (
          <DeviceDuoControls
            screen={screen}
            state={duoState}
            enabled={streaming && inputConnected}
            onCommand={duoCommand}
          />
        ) : null}
      </div>
      <div className="device-viewer-rail" role="toolbar" aria-label={android ? "Emulator controls" : "Simulator controls"}>
        {android ? (
          <>
            {railButton("Back", <ArrowLeft aria-hidden />, () => clientRef.current?.pressButton("back"), !streaming)}
            {railButton("Home", <House aria-hidden />, () => clientRef.current?.pressButton("home"), !streaming)}
            {railButton("Recents", <Square aria-hidden />, () => clientRef.current?.pressButton("recents"), !streaming)}
            {railButton("Power", <Lock aria-hidden />, () => clientRef.current?.pressButton("power"), !streaming)}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label="Rotate"
                  title="Rotate"
                  disabled={!streaming || controls.disabled}
                >
                  <RotateCw aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuLabel>Orientation</DropdownMenuLabel>
                {DEVICE_ORIENTATION_OPTIONS.map((option) => (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    checked={
                      screen !== null &&
                      (option.value === "portrait") === (screen.width <= screen.height)
                    }
                    onSelect={() => void controls.act({ type: "setOrientation", value: option.value })}
                  >
                    {option.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <>
            {railButton("Home", <House aria-hidden />, () => clientRef.current?.pressButton("home"), !streaming)}
            {railButton("Lock", <Lock aria-hidden />, () => clientRef.current?.pressButton("lock"), !streaming)}
            {railButton("Rotate", <RotateCw aria-hidden />, () => clientRef.current?.rotate(), !streaming)}
          </>
        )}
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
              iconOnly
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
        <DeviceScreenshotControl
          disabled={busy !== null}
          onScreenshotToChat={screenshotToChat}
          onSaveScreenshot={() =>
            void run("save a screenshot", () =>
              saveScreenshotWithFeedback({ hostId: session.hostId, deviceId: session.deviceId }),
            )
          }
          onSaveFramedScreenshot={
            frame3d && captureFramed
              ? () =>
                  void run("save a framed screenshot", () =>
                    saveFramedScreenshotWithFeedback({ hostId: session.hostId, deviceId: session.deviceId }, captureFramed),
                  )
              : undefined
          }
        />
        {capabilities.recording ? <DeviceRecordControl chatId={chatId} target={featureTarget} disabled={!streaming} /> : null}
        <Button
          variant={showing3d ? "muted" : "transparent"}
          size="small"
          iconOnly
          aria-label="3D view"
          title={frameBlockerLabel(blocker)}
          aria-pressed={showing3d}
          // aria-disabled keeps the button focusable and hoverable so the reason stays reachable.
          aria-disabled={blocker !== null || undefined}
          aria-describedby={blocker !== null ? frameBlockerId : undefined}
          className={blocker !== null ? "opacity-45" : undefined}
          onClick={() => chooseFrame("3d")}
        >
          <Box aria-hidden />
        </Button>
        {blocker !== null ? (
          <span id={frameBlockerId} className="sr-only">
            {frameBlockerLabel(blocker)}
          </span>
        ) : null}
        <Button
          variant={showing3d ? "transparent" : "muted"}
          size="small"
          iconOnly
          aria-label="Flat view"
          title="Flat view"
          aria-pressed={!showing3d}
          onClick={() => chooseFrame("flat")}
        >
          <Smartphone aria-hidden />
        </Button>
        {frame3d && resetPose ? railButton("Restore 3D view", <Rotate3d aria-hidden />, restoreView) : null}
        <Button
          variant={toolsOpen ? "muted" : "transparent"}
          size="small"
          iconOnly
          ref={toolsTriggerRef}
          aria-label="Device tools"
          title="Device tools"
          aria-pressed={toolsOpen}
          aria-expanded={toolsOpen}
          aria-controls={toolsOpen ? "device-tools" : undefined}
          onClick={() => (toolsOpen ? closeTools() : setToolsOpen(true))}
        >
          <SlidersHorizontal aria-hidden />
        </Button>
        <span className="flex-1" />
        {onFloat ? railButton("Float over chat", <PictureInPicture2 aria-hidden />, onFloat) : null}
        {railButton(`Shut down ${noun}`, <Power aria-hidden />, () => setShutdownOpen(true))}
        {railButton(`Close ${noun}`, <X aria-hidden />, () => onClose(false))}
      </div>
      {toolsOpen ? (
        <div
          id="device-tools"
          ref={toolsRef}
          className="device-viewer-tools"
          onKeyDown={(event) => {
            // Menus inside the drawer portal out of it; their Escape belongs to them.
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (!event.currentTarget.contains(event.target as Node)) return;
            event.preventDefault();
            event.stopPropagation();
            closeTools();
          }}
        >
          <DeviceToolsPanel controls={controls} onClose={closeTools} platform={device.platform}>
            {/* Each section inside shows only where `deviceFeatureCapabilities` says it works. */}
            <DeviceFeatureSections
              chatId={chatId}
              target={featureTarget}
              deviceName={device.name}
              grants={featureGrants}
              axOverlay={axOverlay}
              axStatus={axStatus}
              onAxOverlayChange={(enabled) => {
                setAxOverlay(enabled);
                if (!enabled) setAxStatus(null);
              }}
              onAxRefresh={() => setAxRefresh((value) => value + 1)}
              sendKey={streaming && inputConnected ? sendDeviceKey : null}
              disabled={!streaming}
              onReconnect={reconnect}
              onCloseSession={() => onClose(false)}
              {...(controls.settings?.foregroundApp ? { foregroundApp: controls.settings.foregroundApp } : {})}
            />
          </DeviceToolsPanel>
        </div>
      ) : null}
      <AlertDialog
        open={shutdownOpen}
        onOpenChange={setShutdownOpen}
        title={`Shut down ${device.name}?`}
        description={`The ${noun} and any apps running on it stop. Close ${noun} instead keeps it running in the background.`}
        confirmLabel="Shut down"
        confirmVariant="destructive"
        onConfirm={() => onClose(true)}
      />
    </section>
  );
}
