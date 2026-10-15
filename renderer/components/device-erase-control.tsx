/**
 * Erase all content and settings, from the Device tools drawer. A destructive
 * confirmation names the simulator first. The simulator shuts down if it is
 * running, is erased, and the user is offered to boot it again here. An
 * Android emulator is wiped by one headless cold boot with `-wipe-data`; its
 * progress and Boot offer are a toast, since its session ends at shutdown.
 * Only the user can erase: there is no agent tool for it.
 */
import * as React from "react";
import { Eraser } from "lucide-react";
import { AlertDialog, Button, Dialog, Text, toast } from "./ui";
import { ToolsSection } from "./device-tools-panel";
import { devicesApi } from "../lib/ipc";
import type { DeviceFeatureTarget } from "../shared/device-features";

export interface DeviceEraseApi {
  erase(target: DeviceFeatureTarget): Promise<{ wasBooted: boolean; deviceId: string }>;
  open(input: { chatId: string; hostId: string; deviceId: string }): Promise<unknown>;
}

const defaultApi: DeviceEraseApi = {
  erase: (target) => devicesApi.erase(target),
  open: (input) => devicesApi.open(input),
};

export function DeviceEraseSection(props: {
  chatId: string;
  target: DeviceFeatureTarget;
  deviceName: string;
  /** Restarts the stream once the simulator is booted again. */
  onReconnect(): void;
  /** Closes the simulator in this chat, leaving it shut down. */
  onCloseSession(): void;
  api?: DeviceEraseApi;
  /** For tests: start with the confirmation open. */
  defaultConfirmOpen?: boolean;
}) {
  const api = props.api ?? defaultApi;
  const [confirmOpen, setConfirmOpen] = React.useState(props.defaultConfirmOpen ?? false);
  const [erasing, setErasing] = React.useState(false);
  const [bootOffer, setBootOffer] = React.useState(false);
  const [booting, setBooting] = React.useState(false);

  const android = props.target.platform === "android";
  const noun = android ? "emulator" : "simulator";

  /**
   * An emulator's id changes when it shuts down (serial to AVD name), which
   * ends this viewer's session while the wipe boot still runs. So its progress
   * and the Boot offer live in a toast that outlasts the viewer.
   */
  const eraseEmulator = async () => {
    setConfirmOpen(false);
    const { chatId, deviceName } = props;
    const hostId = props.target.hostId;
    const progress = toast.loading(`Erasing ${deviceName}… It boots once, out of view, to reset.`);
    try {
      const { deviceId } = await api.erase(props.target);
      toast.success(`${deviceName} was erased. It is shut down.`, {
        id: progress,
        duration: 20_000,
        action: {
          label: "Boot",
          onClick: () =>
            void api.open({ chatId, hostId, deviceId }).catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : "The emulator could not be booted.");
            }),
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The emulator could not be erased.", { id: progress });
    }
  };

  const erase = async () => {
    if (android) {
      await eraseEmulator();
      return;
    }
    setErasing(true);
    try {
      await api.erase(props.target);
      setConfirmOpen(false);
      setBootOffer(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The simulator could not be erased.");
      setConfirmOpen(false);
    } finally {
      setErasing(false);
    }
  };

  const boot = async () => {
    setBooting(true);
    try {
      await api.open({ chatId: props.chatId, hostId: props.target.hostId, deviceId: props.target.deviceId });
      setBootOffer(false);
      props.onReconnect();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The simulator could not be booted.");
    } finally {
      setBooting(false);
    }
  };

  return (
    <ToolsSection title="Device">
      <div className="device-tools-actions">
        <Button size="small" variant="muted" disabled={erasing} onClick={() => setConfirmOpen(true)}>
          <Eraser aria-hidden />
          Erase all content and settings…
        </Button>
      </div>
      <Text variant="small" color="secondary">
        Returns the {noun} to a fresh install. It shuts down first if it is running.
      </Text>
      <AlertDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Erase ${props.deviceName}?`}
        description={
          <>
            All content and settings on {props.deviceName} are erased, including installed apps and their data.
            The {noun} shuts down first if it is running. This cannot be undone.
          </>
        }
        confirmLabel={erasing ? "Erasing…" : "Erase"}
        confirmVariant="destructive"
        busy={erasing}
        keepOpenOnConfirm
        onConfirm={erase}
      />
      <Dialog
        open={bootOffer}
        onOpenChange={(next) => {
          if (next || booting) return;
          setBootOffer(false);
          props.onCloseSession();
        }}
        title={`${props.deviceName} was erased`}
        description="It is shut down. Boot it again to keep using it here, or close it; you can open it later from the simulator list."
        confirmLabel={booting ? "Booting…" : "Boot"}
        cancelLabel="Close simulator"
        busy={booting}
        onConfirm={boot}
      />
    </ToolsSection>
  );
}
