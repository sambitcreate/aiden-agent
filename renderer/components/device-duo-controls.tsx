/**
 * Adapted from t3code apps/web/src/components/device/DeviceDuoControls.tsx @ 1c127066 (MIT).
 * The pose glyphs are Aiden's own; T3's are derived from another product's toolbar art.
 */
import { CircleAlert } from "lucide-react";
import { Button } from "./ui";
import { DUO_POSES, type DuoCommand, type DuoControlState, type DuoPose } from "../lib/device-duo-control";
import type { DeviceScreenSize } from "../lib/device-stream";

/** Side-on outlines of the two panels around the hinge. */
function DuoPoseGlyph({ pose }: { pose: DuoPose }) {
  const paths: Record<DuoPose, string> = {
    closed: "M5 17h14M5 14h14",
    book: "M12 18 6 7M12 18l6-11",
    open: "M3 15h8.4M12.6 15H21",
    laptop: "M6 17h12M6 17 5 6",
    tent: "M12 6 6 18M12 6l6 12",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[pose]} />
      {pose === "open" ? <circle cx="12" cy="15" r="0.9" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

/** Which pose buttons read as pressed. Fold shape follows the hinge angle; stances follow the reported pose. */
export function selectedDuoPose(screen: Pick<DeviceScreenSize, "hingeAngle" | "hingePose">, pose: DuoPose): boolean {
  if (pose === "laptop" || pose === "tent") return screen.hingePose === pose;
  const angle = screen.hingeAngle;
  if (angle == null) return false;
  const fold = angle === 0 ? "closed" : angle === 180 ? "open" : "book";
  return fold === pose && screen.hingePose !== "laptop" && screen.hingePose !== "tent";
}

export function DeviceDuoControls(props: {
  screen: DeviceScreenSize;
  state: DuoControlState;
  enabled: boolean;
  onCommand(command: DuoCommand): void;
}) {
  const groups = [
    { label: "Fold shape", poses: DUO_POSES.slice(0, 3) },
    { label: "Device stance", poses: DUO_POSES.slice(3) },
  ];
  return (
    <div className="device-duo-controls" aria-label="iPhone Duo poses">
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label} className="device-duo-group">
          {group.poses.map((pose) => {
            const selected = selectedDuoPose(props.screen, pose.id);
            const name = pose.id === "book" ? "Book / bookshelf" : pose.label;
            return (
              <Button
                key={pose.id}
                variant={selected ? "muted" : "transparent"}
                size="medium"
                iconOnly
                aria-label={`${name} pose`}
                aria-pressed={selected}
                title={name}
                disabled={!props.enabled}
                onClick={() => props.onCommand({ control: "pose", value: pose.id })}
              >
                <DuoPoseGlyph pose={pose.id} />
              </Button>
            );
          })}
        </div>
      ))}
      {props.state.error ? (
        <span className="device-duo-error" role="alert" title={props.state.error}>
          <CircleAlert aria-hidden />
          <span className="sr-only">{props.state.error}</span>
        </span>
      ) : null}
    </div>
  );
}
