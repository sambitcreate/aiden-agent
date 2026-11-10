// The order Present walks through a page: its top-level frames, row by row
// from the top, and left to right within a row, the way a page of designs is
// read. Lines and drawn strokes are skipped; they are part of what is around
// them. Hidden frames are skipped too.

import { isDesignLine, type DesignFrame } from "./schema.js";

type Box = Pick<DesignFrame, "id" | "kind" | "x" | "y" | "w" | "h" | "groupId" | "hidden">;

/** The ids of the frames Present shows, in the order it shows them. */
export function presentationOrder(frames: readonly Box[]): string[] {
  const shown = frames.filter((frame) => frame.groupId === undefined && !frame.hidden && !isDesignLine(frame.kind));
  const byTop = [...shown].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Box[][] = [];
  let row: Box[] = [];
  let rowBottom = -Infinity;
  for (const frame of byTop) {
    // A frame starts a new row once it begins below the middle of the row so far,
    // so frames of different heights side by side still read as one row.
    const rowMiddle = row.length > 0 ? (row[0]!.y + rowBottom) / 2 : -Infinity;
    if (row.length > 0 && frame.y >= rowMiddle) {
      rows.push(row);
      row = [];
      rowBottom = -Infinity;
    }
    row.push(frame);
    rowBottom = Math.max(rowBottom, frame.y + frame.h);
  }
  if (row.length > 0) rows.push(row);
  return rows.flatMap((entries) => [...entries].sort((a, b) => a.x - b.x).map((frame) => frame.id));
}
