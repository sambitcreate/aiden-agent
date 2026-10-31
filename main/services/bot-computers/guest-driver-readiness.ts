// Whether a base's guest driver may be used (plan §8.6): the guided grant of
// Accessibility and Screen Recording inside the guest, and the probe that
// records it. Clones copy the base's disk, the grants with it, and the flag
// Aiden records here; a Bot's `computer` tool takes the driver lane only when
// its computer carries the flag for the pinned driver version, and the VNC
// lane otherwise.

import { CUA_DRIVER_TOOL_SCHEMA, CUA_DRIVER_VERSION } from "../computer-use/contract.js";
import type { CuaDriverSessionLike } from "../computer-use/controller.js";

export interface GuestDriverPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export type GuestDriverProbe =
  | { ready: true; permissions: GuestDriverPermissions }
  | {
      ready: false;
      permissions: GuestDriverPermissions;
      reason: "permissions" | "wrong_version" | "no_apps" | "no_capture";
    };

/** What a base (and each computer made from it) records once the probe passed. */
export interface GuestDriverRecord {
  version: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function structured(result: unknown): Record<string, unknown> | undefined {
  const value = asRecord(result);
  if (!value || value.isError === true) return undefined;
  return asRecord(value.structuredContent);
}

function hasImage(result: unknown): boolean {
  const value = asRecord(result);
  if (!value || value.isError === true || !Array.isArray(value.content)) return false;
  return value.content.some((block) => {
    const item = asRecord(block);
    return item?.type === "image" && typeof item.data === "string" && item.data.length > 0;
  });
}

const PROBE_TIMEOUT_MS = 30_000;

/** The grants as the guest driver reports them; prompting raises the guest's own system prompts. */
export async function guestDriverPermissions(
  session: CuaDriverSessionLike,
  options: { prompt: boolean; signal?: AbortSignal },
): Promise<GuestDriverPermissions> {
  const report = structured(
    await session.callTool(
      "check_permissions",
      { prompt: options.prompt },
      { signal: options.signal, timeoutMs: PROBE_TIMEOUT_MS },
    ),
  );
  return {
    accessibility: report?.accessibility === true,
    // A probe that did run and could not capture vetoes the preflight.
    screenRecording: report?.screen_recording === true && report.screen_recording_capturable !== false,
  };
}

/**
 * The readiness probe: the pinned version, both grants, the app list, and one
 * real window capture with pixels. Any failure leaves the base on the VNC lane.
 */
export async function probeGuestDriver(session: CuaDriverSessionLike, signal?: AbortSignal): Promise<GuestDriverProbe> {
  const call = (name: string, args: Record<string, unknown>) =>
    session.callTool(name, args, { signal, timeoutMs: PROBE_TIMEOUT_MS });
  const permissions = await guestDriverPermissions(session, { prompt: false, signal });
  const health = structured(await call("health_report", {}));
  if (health?.driver_version !== CUA_DRIVER_VERSION || health.schema_version !== CUA_DRIVER_TOOL_SCHEMA) {
    return { ready: false, permissions, reason: "wrong_version" };
  }
  if (!permissions.accessibility || !permissions.screenRecording) return { ready: false, permissions, reason: "permissions" };
  const apps = structured(await call("list_apps", {}));
  if (!Array.isArray(apps?.apps) || apps.apps.length === 0) return { ready: false, permissions, reason: "no_apps" };
  const listed = structured(await call("list_windows", { on_screen_only: true }));
  const windows = Array.isArray(listed?.windows) ? listed.windows.map(asRecord) : [];
  for (const window of windows.slice(0, 5)) {
    const pid = window?.pid;
    const windowId = window?.window_id;
    if (typeof pid !== "number" || typeof windowId !== "number") continue;
    const state = await call("get_window_state", {
      pid,
      window_id: windowId,
      include_accessibility_tree: false,
      include_screenshot: true,
      tree_format: "markdown",
    }).catch(() => undefined);
    if (hasImage(state)) return { ready: true, permissions };
  }
  return { ready: false, permissions, reason: "no_capture" };
}

/** A computer may use the guest driver lane only with a recorded pass for the pinned driver. */
export function guestDriverReady(record: GuestDriverRecord | undefined): boolean {
  return record?.version === CUA_DRIVER_VERSION;
}
