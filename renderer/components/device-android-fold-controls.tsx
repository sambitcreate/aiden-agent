/**
 * Adapted from t3code apps/web/src/components/device/DeviceAndroidFoldControls.tsx @ a6ec88f7 (MIT).
 * The glyphs are Aiden's own side-on outlines, matching the iPhone Duo controls.
 */
import { CircleAlert } from "lucide-react";
import { Button } from "./ui";
import type { AndroidFoldPosture, AndroidFoldView } from "../lib/device-fold";

function FoldGlyph({ posture }: { posture: AndroidFoldPosture }) {
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
      <path d={posture === "closed" ? "M5 17h14M5 14h14" : "M3 15h8.4M12.6 15H21"} />
      {posture === "opened" ? <circle cx="12" cy="15" r="0.9" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

const ACTIONS: ReadonlyArray<{ posture: AndroidFoldPosture; label: string }> = [
  { posture: "closed", label: "Fold device" },
  { posture: "opened", label: "Unfold device" },
];

/** Fold and Unfold for an Android foldable emulator. Renders nothing for an emulator without a hinge. */
export function DeviceAndroidFoldControls({ fold, enabled }: { fold: AndroidFoldView; enabled: boolean }) {
  if (!fold.supported) return null;
  const posture = fold.fold?.posture ?? null;
  return (
    <div className="device-duo-controls" aria-label="Android fold controls" aria-busy={fold.pending}>
      <div role="group" aria-label="Fold posture" className="device-duo-group">
        {ACTIONS.map((action) => (
          <Button
            key={action.posture}
            variant={posture === action.posture ? "muted" : "transparent"}
            size="medium"
            iconOnly
            aria-label={action.label}
            aria-pressed={posture === action.posture}
            title={action.label}
            disabled={fold.pending || !enabled}
            onClick={() => fold.change(action.posture)}
          >
            <FoldGlyph posture={action.posture} />
          </Button>
        ))}
      </div>
      {fold.error ? (
        <span className="device-duo-error" role="alert" title={fold.error}>
          <CircleAlert aria-hidden />
          <span className="sr-only">{fold.error}</span>
        </span>
      ) : null}
    </div>
  );
}
