import { isWaylandSession } from "../../linux-wayland-vulkan-core.js";
import type { LiveDisplaySourceSummary } from "../../../renderer/shared/assistant-live.js";

/**
 * How Live's screen share picks a source on Linux.
 * - `portal`: a Wayland session. The desktop's screen-share portal shows its
 *   own picker when Aiden asks for sources and returns only the chosen one.
 * - `list`: X11 (or Aiden forced onto X11). Every screen and window is listed,
 *   so Aiden shows its own picker and the person chooses one.
 */
export type LiveDisplayPickerMode = "portal" | "list";

export function liveDisplayPickerMode(
  env: NodeJS.ProcessEnv = process.env,
  ozonePlatformOverride?: string,
): LiveDisplayPickerMode {
  if (ozonePlatformOverride?.trim().toLowerCase() === "x11") return "list";
  return isWaylandSession(env) ? "portal" : "list";
}

/** Electron's desktopCapturer, narrowed to what Live uses. */
export interface LiveDisplayCapturer {
  getSources(options: Electron.SourcesOptions): Promise<Electron.DesktopCapturerSource[]>;
}

export const LIVE_DISPLAY_SOURCE_LIMIT = 24;
const THUMBNAIL_SIZE = { width: 320, height: 200 } as const;
const MAX_NAME_LENGTH = 120;
const MAX_THUMBNAIL_CHARS = 400_000;
const SOURCE_ID_PATTERN = /^(screen|window):[A-Za-z0-9._-]{1,40}:[A-Za-z0-9._-]{1,40}$/u;

export function isLiveDisplaySourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID_PATTERN.test(value);
}

function kindOf(id: string): "screen" | "window" {
  return id.startsWith("screen:") ? "screen" : "window";
}

function summary(source: Electron.DesktopCapturerSource, index: number): LiveDisplaySourceSummary {
  const kind = kindOf(source.id);
  const name =
    source.name.trim().slice(0, MAX_NAME_LENGTH) ||
    (kind === "screen" ? `Screen ${index + 1}` : "Untitled window");
  let thumbnail = "";
  try {
    if (!source.thumbnail.isEmpty()) {
      const url = source.thumbnail.toDataURL();
      if (url.length <= MAX_THUMBNAIL_CHARS) thumbnail = url;
    }
  } catch {
    thumbnail = "";
  }
  return { id: source.id, name, kind, thumbnail };
}

/**
 * Lists screens first, then windows, for Aiden's own picker. Ids Electron
 * returns in an unexpected shape are left out, since the person's choice must
 * come back through a strict parser.
 */
export async function listLiveDisplaySources(
  capturer: LiveDisplayCapturer,
): Promise<LiveDisplaySourceSummary[]> {
  const sources = await capturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: THUMBNAIL_SIZE,
    fetchWindowIcons: false,
  });
  const valid = sources.filter((source) => isLiveDisplaySourceId(source.id));
  const screens = valid.filter((source) => kindOf(source.id) === "screen");
  const windows = valid.filter((source) => kindOf(source.id) === "window");
  return [...screens, ...windows]
    .slice(0, LIVE_DISPLAY_SOURCE_LIMIT)
    .map((source, index) => summary(source, index));
}

/**
 * The source for an admitted capture request. With a chosen id (Aiden's
 * picker) it must still exist; without one (the portal) the desktop's own
 * picker runs now and its choice is used. Anything else denies.
 */
export async function resolveLiveDisplaySource(
  capturer: LiveDisplayCapturer,
  mode: LiveDisplayPickerMode,
  sourceId: string | null,
): Promise<Electron.DesktopCapturerSource | null> {
  if (sourceId === null && mode !== "portal") return null;
  const sources = await capturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  if (sourceId !== null) return sources.find((source) => source.id === sourceId) ?? null;
  // The portal returns only what the person chose there (nothing if they cancelled).
  return sources[0] ?? null;
}
