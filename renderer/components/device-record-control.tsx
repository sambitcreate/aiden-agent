/**
 * Screen recording from the simulator rail. Recording shows a live indicator
 * with the elapsed time; stopping (or the cap: ten minutes on iOS, three on an
 * Android emulator, whose screenrecord stops there) finalizes the file
 * and opens the save dialog, defaulting to Downloads. A saved recording can be
 * revealed in Finder. Cancelling the dialog deletes the recording.
 */
import * as React from "react";
import { Square, Video } from "lucide-react";
import { Button, toast } from "./ui";
import { devicesApi } from "../lib/ipc";
import {
  deviceRecordingMaxMs,
  type DeviceFeatureTarget,
  type DeviceRecordingInfo,
} from "../shared/device-features";

/** `m:ss`, the way a recording indicator reads. */
export function formatRecordingElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "1 minute 5 seconds" for assistive technology. */
export function spokenRecordingElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const part = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  return minutes > 0 ? `${part(minutes, "minute")} ${part(rest, "second")}` : part(rest, "second");
}

const fileName = (path: string) => path.split("/").pop() ?? path;

export async function saveRecordingWithFeedback(info: DeviceRecordingInfo): Promise<void> {
  try {
    if (info.reason === "max-duration") {
      toast.info(`The recording stopped at ${Math.round((info.endsBy - info.startedAt) / 60_000)} minutes.`);
    }
    const result = await devicesApi.saveRecording(info.id);
    if (result.status !== "saved") return;
    toast.success(`Saved ${fileName(result.path)}.`, {
      action: { label: "Reveal in Finder", onClick: () => void devicesApi.revealSaved(result.path).catch(() => undefined) },
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "The recording could not be saved.");
  }
}

export function DeviceRecordControl(props: {
  chatId: string;
  target: DeviceFeatureTarget;
  disabled: boolean;
  /** For tests: a recording to show without the IPC feed. */
  initial?: DeviceRecordingInfo[];
  now?: () => number;
}) {
  const now = props.now ?? Date.now;
  const [recordings, setRecordings] = React.useState<DeviceRecordingInfo[]>(props.initial ?? []);
  const [starting, setStarting] = React.useState(false);
  const [, tick] = React.useState(0);
  const handled = React.useRef(new Set<string>());
  const { chatId, target } = props;

  React.useEffect(() => {
    if (props.initial) return;
    let live = true;
    const off = devicesApi.onRecordings((list) => {
      if (live) setRecordings(list);
    });
    devicesApi
      .recordings()
      .then((list) => {
        if (live) setRecordings(list);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, [props.initial]);

  const mine = recordings.find(
    (info) => info.chatId === chatId && info.hostId === target.hostId && info.deviceId === target.deviceId,
  );

  React.useEffect(() => {
    if (mine?.status !== "recording") return;
    const timer = setInterval(() => tick((value) => value + 1), 500);
    return () => clearInterval(timer);
  }, [mine?.status]);

  // A recording that finished here, by the cap, or by itself, is offered for saving once.
  React.useEffect(() => {
    if (props.initial || !mine || handled.current.has(mine.id)) return;
    if (mine.status === "ready") {
      handled.current.add(mine.id);
      void saveRecordingWithFeedback(mine);
    } else if (mine.status === "failed") {
      handled.current.add(mine.id);
      toast.error(mine.error ?? "The recording failed.");
      void devicesApi.discardRecording(mine.id).catch(() => undefined);
    }
  }, [mine, props.initial]);

  const replace = (info: DeviceRecordingInfo) =>
    setRecordings((current) => [...current.filter((item) => item.id !== info.id), info]);

  const start = async () => {
    setStarting(true);
    try {
      replace(await devicesApi.startRecording({ chatId, ...target }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The recording could not start.");
    } finally {
      setStarting(false);
    }
  };
  const stop = async (id: string) => {
    try {
      replace(await devicesApi.stopRecording(id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The recording could not stop.");
    }
  };

  if (mine?.status === "recording" || mine?.status === "stopping") {
    const elapsed = (mine.stoppedAt ?? now()) - mine.startedAt;
    const stopping = mine.status === "stopping";
    return (
      <Button
        variant="muted"
        size="small"
        className="device-record-indicator"
        aria-label={stopping ? "Finishing the recording" : `Stop recording, ${spokenRecordingElapsed(elapsed)} recorded`}
        title={stopping ? "Finishing the recording…" : "Stop recording"}
        disabled={stopping}
        data-recording={!stopping || undefined}
        onClick={() => void stop(mine.id)}
      >
        <span className="device-record-dot" aria-hidden />
        <span className="device-record-time" aria-hidden>
          {formatRecordingElapsed(elapsed)}
        </span>
        <Square aria-hidden className="device-record-stop" />
      </Button>
    );
  }
  return (
    <Button
      variant="transparent"
      size="small"
      iconOnly
      aria-label="Record screen"
      title={`Record screen (up to ${deviceRecordingMaxMs(target.platform) / 60_000} minutes)`}
      disabled={props.disabled || starting}
      onClick={() => void start()}
    >
      <Video aria-hidden />
    </Button>
  );
}
