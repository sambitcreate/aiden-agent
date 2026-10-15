/**
 * Adapted from t3code apps/web/src/components/device/DeviceDuoControls.tsx @ a6ec88f7 (MIT).
 * The glyphs are Aiden's own drawings; T3's are ported from another product's toolbar art.
 */
import * as React from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "./ui";
import {
  duoFoldState,
  duoHoldOrientation,
  type DuoCommand,
  type DuoControlState,
} from "../lib/device-duo-control";
import type { DeviceScreenSize } from "../lib/device-stream";

export const DUO_FOLDS = [
  { id: "closed", angle: 0 },
  { id: "half", angle: 90 },
  { id: "open", angle: 180 },
] as const;
export type DuoFold = (typeof DUO_FOLDS)[number]["id"];
const STANDS = [
  { id: "laptop", label: "Laptop stand" },
  { id: "tent", label: "Tent stand" },
] as const;
type DuoStand = (typeof STANDS)[number]["id"];

/** A half fold opens a vertical phone like a book, and a horizontal one like a laptop. */
export function duoFoldLabel(fold: DuoFold, phoneVertical: boolean): string {
  if (fold === "closed") return "Closed";
  if (fold === "open") return "Open";
  return phoneVertical ? "Book" : "Laptop";
}

/**
 * The commands a fold button sends. Fold shapes move only the hinge. Leaving a
 * stand first turns the device back to how it was held, read in the frame of
 * the display it rests on, then folds.
 */
export function duoFoldCommands(
  angle: number,
  current: { stand: boolean; standVertical: boolean; screenId: number | undefined },
): DuoCommand[] {
  const fold: DuoCommand = { control: "angle", value: angle };
  if (!current.stand) return [fold];
  return [{ control: "orientation", value: duoHoldOrientation(current.standVertical, current.screenId) }, fold];
}

/**
 * Aiden's front-view fold glyphs, drawn as a phone held vertically. `rotated`
 * turns the whole drawing a quarter for a horizontal phone. Stance glyphs are
 * side-on outlines and never rotate.
 */
export function DeviceDuoGlyph({ pose, rotated = false }: { pose: DuoFold | DuoStand; rotated?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="device-duo-glyph"
      data-rotated={rotated || undefined}
      aria-hidden
    >
      {pose === "closed" ? (
        <>
          <rect x="7" y="3.5" width="10" height="17" rx="2.6" />
          <circle cx="12" cy="6.4" r="0.85" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {pose === "half" ? <path d="M12 6.5v11M12 6.5 4.5 4v16l7.5-2.5M12 6.5 19.5 4v16L12 17.5" /> : null}
      {pose === "open" ? (
        <>
          <rect x="3" y="6" width="18" height="12" rx="2.4" />
          <path d="M12 8.5v7" strokeDasharray="1.6 1.8" />
        </>
      ) : null}
      {pose === "laptop" ? <path d="M4.5 17.5h13.5M4.5 17.5 6.5 5.5" /> : null}
      {pose === "tent" ? <path d="M12 5.5 5.5 18.5M12 5.5l6.5 13" /> : null}
    </svg>
  );
}

/**
 * Fold shapes move only the hinge, so the device opens around whichever edge it
 * currently rests on: a vertical phone opens as a book into a landscape tablet,
 * a horizontal one as a laptop into a portrait tablet. Stands are native presets
 * that also place the device. Pinching the 3D model supplies continuous control.
 */
export function DeviceDuoControls(props: {
  screen: DeviceScreenSize;
  state: DuoControlState;
  enabled: boolean;
  onCommand(command: DuoCommand): void;
}) {
  const { screen } = props;
  const { fold, stand, phoneVertical: reportedVertical, settled } = duoFoldState(screen);
  // A fold never changes how the phone is held. Keep the last settled reading
  // through display handoffs, whose interim orientation belongs to the other display.
  const [settledVertical, setSettledVertical] = React.useState(reportedVertical);
  if (settled && settledVertical !== reportedVertical) setSettledVertical(reportedVertical);
  // Stands rotate the device. Folding out of one returns it to how it was held before.
  const [standVertical, setStandVertical] = React.useState(settledVertical);
  const phoneVertical = stand ? standVertical : settledVertical;
  // Folding out of a stand sends the rotation back, then the fold, and only one command can
  // wait. Hold the fold buttons until a stand, or anything queued on one, has landed.
  const foldWaits = props.state.pending && (stand || props.state.requested?.control === "pose");
  const button = (key: string, label: string, pressed: boolean, onClick: () => void, glyph: React.ReactNode, waits = false) => (
    <Button
      key={key}
      variant={pressed ? "muted" : "transparent"}
      size="medium"
      iconOnly
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={!props.enabled || waits}
      onClick={onClick}
    >
      {glyph}
    </Button>
  );
  return (
    <div className="device-duo-controls" aria-label="iPhone Duo hinge">
      <div role="group" aria-label="Fold shape" className="device-duo-group">
        {DUO_FOLDS.map(({ id, angle }) =>
          button(
            id,
            duoFoldLabel(id, phoneVertical),
            !stand && fold === id,
            () => {
              for (const command of duoFoldCommands(angle, { stand, standVertical, screenId: screen.screenId })) {
                props.onCommand(command);
              }
            },
            <DeviceDuoGlyph pose={id} rotated={!phoneVertical} />,
            foldWaits,
          ),
        )}
      </div>
      <div role="group" aria-label="Device stance" className="device-duo-group">
        {STANDS.map(({ id, label }) =>
          button(
            id,
            label,
            screen.hingePose === id,
            () => {
              if (!stand) setStandVertical(settledVertical);
              props.onCommand({ control: "pose", value: id });
            },
            <DeviceDuoGlyph pose={id} />,
          ),
        )}
      </div>
      {props.state.error ? (
        <span className="device-duo-error" role="alert" title={props.state.error}>
          <CircleAlert aria-hidden />
          <span className="sr-only">{props.state.error}</span>
        </span>
      ) : null}
    </div>
  );
}
