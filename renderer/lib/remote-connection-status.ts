import type { AidenRemoteDeviceView } from "../shared/aiden-remote";

/**
 * Device last-seen writes are intentionally throttled to five minutes in the
 * main process. A ten-minute window avoids flipping an actively used phone to
 * inactive between those bounded writes.
 */
export const REMOTE_DEVICE_ACTIVE_WINDOW_MS = 10 * 60_000;

export interface RemoteDeviceGroups {
  active: AidenRemoteDeviceView[];
  pending: AidenRemoteDeviceView[];
  inactive: AidenRemoteDeviceView[];
  previous: AidenRemoteDeviceView[];
}

function newestFirst(
  left: AidenRemoteDeviceView,
  right: AidenRemoteDeviceView,
): number {
  const leftTimestamp = left.revokedAt ?? left.lastSeenAt;
  const rightTimestamp = right.revokedAt ?? right.lastSeenAt;
  return rightTimestamp - leftTimestamp;
}

export function groupRemoteDevices(
  devices: readonly AidenRemoteDeviceView[],
  options: { now?: number; serviceRunning: boolean },
): RemoteDeviceGroups {
  const now = options.now ?? Date.now();
  const groups: RemoteDeviceGroups = { active: [], pending: [], inactive: [], previous: [] };

  for (const device of devices) {
    if (device.revokedAt !== undefined) {
      groups.previous.push(device);
      continue;
    }
    if (device.lastSeenAt === 0) {
      groups.pending.push(device);
      continue;
    }
    const seenRecently = device.lastSeenAt >= now - REMOTE_DEVICE_ACTIVE_WINDOW_MS;
    (options.serviceRunning && seenRecently ? groups.active : groups.inactive).push(device);
  }

  groups.active.sort(newestFirst);
  groups.pending.sort((left, right) => right.createdAt - left.createdAt);
  groups.inactive.sort(newestFirst);
  groups.previous.sort(newestFirst);
  return groups;
}

export function remoteConnectionSummary(input: {
  enabled: boolean;
  running: boolean;
  error?: string;
  activeDeviceCount: number;
}): string {
  if (!input.enabled) return "Off";
  if (input.error || !input.running) return "Needs attention";
  if (input.activeDeviceCount === 0) return "Ready for a device";
  return `${input.activeDeviceCount} active`;
}
