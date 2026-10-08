/**
 * Aiden's activity marks: small vector animations that replace the canvas
 * thinking orbs. Desktop, iOS and Android each draw the same marks from the
 * geometry and timing in docs/activity-marks.md, so a mark name means the
 * same picture on every client.
 */
export const ACTIVITY_MARKS = [
  "tri-step",
  "quad-shuffle",
  "compose",
  "scan-grid",
  "glance",
  "bounce",
  "helix-calm",
  "helix-twist",
  "helix-swell",
  "helix-duplex",
  "helix-flat",
] as const;

export type ActivityMark = (typeof ACTIVITY_MARKS)[number];

