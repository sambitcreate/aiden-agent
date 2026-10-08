/**
 * The Device tools drawer sections for the device power features, mounted as
 * one block after the settings sections: the accessibility overlay switch,
 * clipboard transfer, the event log (logcat on Android), and erase. Each
 * section appears only where `deviceFeatureCapabilities` says it works:
 * clipboard and erase run `simctl` or `adb` on this Mac, so a paired Mac's
 * device shows only the overlay and the event log.
 */
import { RefreshCw } from "lucide-react";
import { Button, Switch, Text } from "./ui";
import { Row, ToolsSection } from "./device-tools-panel";
import type { DeviceAxStatus } from "./device-ax-overlay";
import { DeviceClipboardSection } from "./device-clipboard-controls";
import { DeviceEraseSection } from "./device-erase-control";
import { DeviceEventLogSection } from "./device-event-log-panel";
import type { DeviceGrantSource } from "../lib/device-grant";
import { deviceFeatureCapabilities, type DeviceFeatureTarget } from "../shared/device-features";
import { LOCAL_DEVICE_HOST_ID } from "../shared/devices";

export function axStatusLabel(status: DeviceAxStatus | null): string | null {
  if (!status) return null;
  if (status.loading) return "Reading the accessibility tree…";
  if (status.error) return status.error;
  return status.count === 1 ? "1 element" : `${status.count} elements`;
}

export function DeviceFeatureSections(props: {
  chatId: string;
  target: DeviceFeatureTarget;
  deviceName: string;
  grants: DeviceGrantSource;
  axOverlay: boolean;
  axStatus: DeviceAxStatus | null;
  /** Element frames draw over the flat screen only; the 3D frame is off while they show. */
  onAxOverlayChange(enabled: boolean): void;
  /** Reads a paired Mac's tree again; this Mac's tree refreshes on its own. */
  onAxRefresh(): void;
  sendKey: ((code: string, phase: "down" | "up") => void) | null;
  disabled: boolean;
  onReconnect(): void;
  onCloseSession(): void;
  /** Android: the frontmost app, which the logcat view can be narrowed to. */
  foregroundApp?: string;
}) {
  const local = props.target.hostId === LOCAL_DEVICE_HOST_ID;
  const capabilities = deviceFeatureCapabilities(props.target.platform, { local });
  const status = props.axOverlay ? axStatusLabel(props.axStatus) : null;
  return (
    <>
      {capabilities.axOverlay ? (
        <ToolsSection title="Accessibility">
          <Row label="Overlay element frames">
            {props.axOverlay && !local ? (
              <Button size="small" variant="transparent" iconOnly aria-label="Read element frames again" onClick={props.onAxRefresh}>
                <RefreshCw aria-hidden />
              </Button>
            ) : null}
            <Switch
              aria-label="Overlay element frames"
              checked={props.axOverlay}
              onCheckedChange={props.onAxOverlayChange}
            />
          </Row>
          {status ? (
            <Text variant="small" color="secondary" role="status">
              {status}
            </Text>
          ) : (
            <Text variant="small" color="secondary">
              Hover the screen to see an element&apos;s label and role. Frames show on the flat screen.
            </Text>
          )}
        </ToolsSection>
      ) : null}
      {capabilities.clipboardPaste ? (
        <DeviceClipboardSection
          target={props.target}
          sendKey={props.sendKey}
          disabled={props.disabled}
          copy={capabilities.clipboardCopy}
        />
      ) : null}
      {capabilities.eventLog ? (
        <DeviceEventLogSection
          hostId={props.target.hostId}
          deviceId={props.target.deviceId}
          platform={props.target.platform}
          grants={props.grants}
          {...(props.foregroundApp ? { foregroundApp: props.foregroundApp } : {})}
        />
      ) : null}
      {capabilities.erase ? (
        <DeviceEraseSection
          chatId={props.chatId}
          target={props.target}
          deviceName={props.deviceName}
          onReconnect={props.onReconnect}
          onCloseSession={props.onCloseSession}
        />
      ) : null}
    </>
  );
}
