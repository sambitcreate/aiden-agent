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

const pictures = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;

function pictureKey(frameId: string, versionId: string): string {
  return `${frameId}\n${versionId}`;
}

/** Keeps a version's picture for this app run. */
export function keepDesignTweakVersionPicture(frameId: string, versionId: string, dataUrl: string): void {
  const key = pictureKey(frameId, versionId);
  pictures.delete(key);
  pictures.set(key, dataUrl);
  while (pictures.size > PICTURE_LIMIT) pictures.delete(pictures.keys().next().value as string);
  revision += 1;
  for (const listener of listeners) listener();
}

/** V1 is the page as its file says; it is never stored. */
export const DESIGN_TWEAK_V1 = "v1";

/** The look a frame shows for one of its versions, or null when it has no such version. */
function versionLook(frame: DesignFrame | undefined, versionId: string): { tweaks?: DesignFrame["tweaks"]; dark?: true } | null {
  if (frame?.kind !== "file") return null;
  if (versionId === DESIGN_TWEAK_V1) return {};
  return frame.tweakVersions?.find((version) => version.id === versionId) ?? null;
}

/**
 * Takes a version's picture after `delay` and keeps it, but only while the
 * canvas's frame (read fresh through `frameNow`, not from whichever editor
 * asked) still has that version and shows it, both before the capture starts
 * and when it comes back. So a quick switch, an edit, a closed panel or a
 * deleted version never files one look's picture under another.
 */
export function takeDesignTweakVersionPicture(
  frameId: string,
  versionId: string,
  delay: number,
  frameNow: (frameId: string) => DesignFrame | undefined,
  capture: (frameId: string) => Promise<string | null>,
): void {
  const shows = () => {
    const frame = frameNow(frameId);
    const look = versionLook(frame, versionId);
    return frame !== undefined && look !== null && showsDesignTweakVersion(frame, look);
  };
  setTimeout(() => {
    if (!shows()) return;
    void capture(frameId).then(
      (picture) => {
        if (picture && shows()) keepDesignTweakVersionPicture(frameId, versionId, picture);
      },
      () => undefined,
    );
  }, delay);
}

export function forgetDesignTweakVersionPicture(frameId: string, versionId: string): void {
  if (!pictures.delete(pictureKey(frameId, versionId))) return;
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A version's picture, if one was taken since the app started. */
export function designTweakVersionPicture(frameId: string, versionId: string): string | undefined {
  return pictures.get(pictureKey(frameId, versionId));
}

export function useDesignTweakVersionPicture(frameId: string, versionId: string): string | undefined {
  React.useSyncExternalStore(subscribe, () => revision, () => revision);
  return designTweakVersionPicture(frameId, versionId);
}
