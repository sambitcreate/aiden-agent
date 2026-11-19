// Tweaks versions on the canvas: Show all, which lays out a copy of a page
// frame for each of its versions, and the versions' pictures, which are kept
// for this app run only (after a restart a version shows its name alone).

import * as React from "react";
import { DESIGN_CANVAS_LIMITS, type DesignCanvas, type DesignFrame } from "../shared/design-canvas/schema";
import { showsDesignTweakVersion } from "../shared/design-canvas/tweaks";

const GAP = 48;
const PAD = 40;
/** Copies per row, so a set of versions stays easy to compare. */
const MOST_PER_ROW = 4;

export type ShownDesignTweakVersions = { doc: DesignCanvas; groupId: string; ids: string[] };

/**
 * Show all: a new group beside a page frame, holding one copy of the page per
 * version (V1, the file as it is, first), laid out in rows. Each copy is an
 * ordinary page frame with that version's values. Null when the frame has no
 * versions or the copies would not fit on the canvas.
 */
export function showDesignTweakVersions(
  doc: DesignCanvas,
  frameId: string,
  newId: () => string,
): ShownDesignTweakVersions | null {
  const frame = doc.frames.find((entry) => entry.id === frameId);
  if (frame?.kind !== "file" || !frame.tweakVersions?.length) return null;
  const versions = [{ name: "V1", tweaks: undefined, dark: undefined }, ...frame.tweakVersions];
  const count = versions.length;
  if (doc.frames.length + count + 1 > DESIGN_CANVAS_LIMITS.frames) return null;
  const onPage = doc.frames.filter((entry) => entry.pageId === frame.pageId).length;
  if (onPage + count + 1 > DESIGN_CANVAS_LIMITS.framesPerPage) return null;

  const fits = Math.floor((DESIGN_CANVAS_LIMITS.maxSize - 2 * PAD + GAP) / (frame.w + GAP));
  const columns = Math.min(count, MOST_PER_ROW, fits);
  if (columns < 1) return null;
  const rows = Math.ceil(count / columns);
  const w = columns * frame.w + (columns - 1) * GAP + 2 * PAD;
  const h = rows * frame.h + (rows - 1) * GAP + 2 * PAD;
  if (h > DESIGN_CANVAS_LIMITS.maxSize) return null;
  // To the page's right, past anything already there, so nothing on the page is covered.
  const top = frame.y - PAD;
  let left = frame.x + frame.w + 2 * GAP;
  const others = doc.frames.filter((entry) => entry.pageId === frame.pageId && entry.id !== frame.id);
  const blocking = (x: number) =>
    others.find(
      (entry) =>
        entry.x < x + w + GAP && x - GAP < entry.x + entry.w && entry.y < top + h + GAP && top - GAP < entry.y + entry.h,
    );
  for (let blocker = blocking(left); blocker; blocker = blocking(left)) {
    left = Math.max(left, blocker.x + blocker.w) + 2 * GAP;
  }
  if (left + w > DESIGN_CANVAS_LIMITS.maxCoord || top < -DESIGN_CANVAS_LIMITS.maxCoord) return null;
  if (top + h > DESIGN_CANVAS_LIMITS.maxCoord) return null;

  const groupId = newId();
  const group: DesignFrame = {
    id: groupId,
    kind: "group",
    title: `${frame.title} versions`.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
    x: left,
    y: top,
    w,
    h,
    pageId: frame.pageId,
    createdBy: "person",
  };
  const ids: string[] = [];
  const copies = versions.map((version, index): DesignFrame => {
    const {
      id: _id,
      groupId: _group,
      locked: _locked,
      hidden: _hidden,
      tweaks: _tweaks,
      dark: _dark,
      tweakVersions: _versions,
      ...rest
    } = frame;
    const id = newId();
    ids.push(id);
    return {
      ...rest,
      id,
      groupId,
      title: `${frame.title} · ${version.name}`.slice(0, DESIGN_CANVAS_LIMITS.titleChars),
      x: left + PAD + (index % columns) * (frame.w + GAP),
      y: top + PAD + Math.floor(index / columns) * (frame.h + GAP),
      ...(version.tweaks ? { tweaks: { ...version.tweaks } } : {}),
      ...(version.dark ? { dark: true as const } : {}),
      createdBy: "person",
    };
  });
  return { doc: { ...doc, frames: [...doc.frames, group, ...copies] }, groupId, ids };
}

// ---- Pictures --------------------------------------------------------------

/** The most version pictures kept at once; the oldest goes first. */
const PICTURE_LIMIT = 120;
/** A version's picture is drawn as a small thumbnail, so it is kept at about this size. */
export const DESIGN_TWEAK_PICTURE_SIDE = 160;

/** Each picture, with the version of the page's file it was taken from. */
const pictures = new Map<string, { picture: string; stamp: number }>();
const listeners = new Set<() => void>();

function pictureKey(frameId: string, versionId: string): string {
  return `${frameId}\n${versionId}`;
}

function changed(): void {
  for (const listener of listeners) listener();
}

/** Keeps a version's picture for this app run, taken from the file's version `stamp`. */
export function keepDesignTweakVersionPicture(frameId: string, versionId: string, dataUrl: string, stamp = 0): void {
  const key = pictureKey(frameId, versionId);
  pictures.delete(key);
  pictures.set(key, { picture: dataUrl, stamp });
  while (pictures.size > PICTURE_LIMIT) pictures.delete(pictures.keys().next().value as string);
  changed();
}

/** V1 is the page as its file says; it is never stored. */
export const DESIGN_TWEAK_V1 = "v1";

/** The look a frame shows for one of its versions, or null when it has no such version. */
function versionLook(frame: DesignFrame | undefined, versionId: string): { tweaks?: DesignFrame["tweaks"]; dark?: true } | null {
  if (frame?.kind !== "file") return null;
  if (versionId === DESIGN_TWEAK_V1) return {};
  return frame.tweakVersions?.find((version) => version.id === versionId) ?? null;
}

/** What taking a version's picture reads from the canvas, fresh each time. */
export type DesignTweakPictureCanvas = {
  frameNow(frameId: string): DesignFrame | undefined;
  /** The version of the frame's file as the canvas shows it now. */
  fileVersion(frame: DesignFrame): number;
  capture(frameId: string): Promise<string | null>;
};

/**
 * Takes a version's picture after `delay` and keeps it, but only while the
 * canvas's frame (read fresh, not from whichever editor asked) still has that
 * version and shows it, both before the capture starts and when it comes
 * back, from the same version of its file. So a quick switch, an edit, a
 * closed panel or a deleted version never files one look's picture under
 * another. A version already pictured from this version of the file is left
 * as it is.
 */
export function takeDesignTweakVersionPicture(
  frameId: string,
  versionId: string,
  delay: number,
  canvas: DesignTweakPictureCanvas,
): void {
  const stampNow = (): number | null => {
    const frame = canvas.frameNow(frameId);
    const look = versionLook(frame, versionId);
    return frame && look && showsDesignTweakVersion(frame, look) ? canvas.fileVersion(frame) : null;
  };
  setTimeout(() => {
    const stamp = stampNow();
    if (stamp === null || pictures.get(pictureKey(frameId, versionId))?.stamp === stamp) return;
    void canvas.capture(frameId).then(
      (picture) => {
        if (picture && stampNow() === stamp) keepDesignTweakVersionPicture(frameId, versionId, picture, stamp);
      },
      () => undefined,
    );
  }, delay);
}

export function forgetDesignTweakVersionPicture(frameId: string, versionId: string): void {
  if (pictures.delete(pictureKey(frameId, versionId))) changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * A version's picture, if one was taken since the app started; with `stamp`,
 * only one taken from that version of the page's file.
 */
export function designTweakVersionPicture(frameId: string, versionId: string, stamp?: number): string | undefined {
  const entry = pictures.get(pictureKey(frameId, versionId));
  return entry && (stamp === undefined || entry.stamp === stamp) ? entry.picture : undefined;
}

/** A version's picture from this version of the file; only the chips whose picture changed render again. */
export function useDesignTweakVersionPicture(frameId: string, versionId: string, stamp: number): string | undefined {
  const read = () => designTweakVersionPicture(frameId, versionId, stamp);
  return React.useSyncExternalStore(subscribe, read, read);
}

/** A picture scaled down so its longest side is at most `side`; the original when it can't be. */
export async function shrinkDesignPicture(dataUrl: string, side = DESIGN_TWEAK_PICTURE_SIDE): Promise<string> {
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    if (longest <= side) return dataUrl;
    const ratio = side / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}
