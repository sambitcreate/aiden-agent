// The base computer's live screen in Settings → Bot computers, while setup
// waits for the person to allow Accessibility and Screen Recording for
// cua-driver inside it (plan §8.6). The same device stream as a Bot's
// Computer tab, served by main's viewer hub; no Bot ever drives the base, so
// every click, key and scroll goes straight to it. The VNC password and
// socket never leave main.

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button, Text } from "../ui";
import { useDocumentVisible } from "../device-mini-player";
import { DEVICE_SCREEN_CONTAINER_STYLE, fittedScreenStyle } from "../../lib/device-display-rotation";
import { botComputersApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { useDeviceScreenWheel } from "../../lib/use-device-screen-wheel";
import { useDeviceStream } from "../../lib/use-device-stream";
import { BOT_COMPUTER_VIEWER_HOST_ID } from "../../shared/bot-computers";

/** A Mac screen's shape until the first frame says otherwise. */
const DEFAULT_ASPECT = 1440 / 900;

function BaseStream({ deviceId }: { deviceId: string }) {
  const visible = useDocumentVisible();
  // Each connection asks main for a fresh grant, which it lends only while setup waits for the person.
  const requestGrant = React.useCallback(async () => (await botComputersApi.baseViewerGrant()).grant, []);
  const stream = useDeviceStream({
    hostId: BOT_COMPUTER_VIEWER_HOST_ID,
    deviceId,
    platform: "ios",
    active: visible,
    preferMjpeg: true,
    requestGrant,
  });
  const screenRef = React.useRef<HTMLDivElement | null>(null);
  useDeviceScreenWheel(screenRef, stream.client);
  const size = stream.screen && stream.screen.width > 0 && stream.screen.height > 0 ? stream.screen : null;
  const aspect = size ? size.width / size.height : DEFAULT_ASPECT;
  return (
    <div className="relative flex h-80 min-h-0 items-center justify-center" style={DEVICE_SCREEN_CONTAINER_STYLE} data-bot-computer-base-view>
      <div
        ref={screenRef}
        className="device-viewer-screen bot-computer-screen"
        data-typing-surface="device"
        style={{ ...DEVICE_SCREEN_CONTAINER_STYLE, ...fittedScreenStyle(aspect) }}
        tabIndex={0}
        role="application"
        aria-roledescription="computer screen"
        aria-label="The base computer's screen. Click or drag to use the mouse; type to send keys while focused."
        onPointerDown={stream.pointer("begin")}
        onPointerMove={stream.pointer("move")}
        onPointerUp={stream.pointer("end")}
        onPointerCancel={stream.pointer("end")}
        onKeyDown={stream.key("down")}
        onKeyUp={stream.key("up")}
        onBlur={stream.releaseKeys}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas ref={stream.canvasRef} hidden={Boolean(stream.mjpegUrl)} aria-hidden />
        {stream.mjpegUrl ? <img ref={stream.attachImage} alt="" draggable={false} /> : null}
        {stream.status === "error" ? (
          <div className="device-viewer-overlay">
            <Text variant="small" color="secondary">
              The base computer's screen stopped updating.
            </Text>
            <Button size="small" variant="muted" onClick={stream.reconnect}>
              <RefreshCw aria-hidden /> Reconnect
            </Button>
          </div>
        ) : null}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {stream.status === "streaming" ? "Showing the base computer" : stream.status === "error" ? "Disconnected" : "Connecting…"}
      </span>
    </div>
  );
}

/** The base computer's screen, lent by main only while setup waits for the grants. */
export function BotComputerBaseScreen() {
  const [deviceId, setDeviceId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    let current = true;
    setError(null);
    botComputersApi.baseViewerGrant().then(
      (lent) => {
        if (current) setDeviceId(lent.deviceId);
      },
      (failure: unknown) => {
        if (current) setError(userFacingErrorMessage(failure, "Aiden couldn't show the base computer's screen."));
      },
    );
    return () => {
      current = false;
    };
  }, []);
  React.useEffect(() => load(), [load]);

  if (deviceId) return <BaseStream key={deviceId} deviceId={deviceId} />;
  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Text as="p" variant="small" color="secondary" role="alert">
          {error}
        </Text>
        <Button size="small" variant="filled" onClick={() => void load()}>
          <RefreshCw aria-hidden /> Try again
        </Button>
      </div>
    );
  }
  return (
    <Text as="p" variant="small" color="tertiary" aria-live="polite">
      Connecting to the base computer…
    </Text>
  );
}
