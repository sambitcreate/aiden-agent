export type AppUpdateSnapshot =
  | {
      status: "idle";
      version: null;
    }
  | {
      status: "ready";
      version: string;
    };

export type AppUpdateRestartResult =
  | {
      accepted: true;
    }
  | {
      accepted: false;
      reason: "busy" | "not-ready" | "unavailable";
    };

export const IDLE_APP_UPDATE_SNAPSHOT: AppUpdateSnapshot = {
  status: "idle",
  version: null,
};

export function normalizeAppUpdateVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return null;
  }
  const version = value.trim();
  if (!version || version.length > 128) return null;
  return version;
}

export function parseAppUpdateSnapshot(value: unknown): AppUpdateSnapshot {
  if (typeof value !== "object" || value === null) return IDLE_APP_UPDATE_SNAPSHOT;
  const record = value as Record<string, unknown>;
  const version = normalizeAppUpdateVersion(record.version);
  return record.status === "ready" && version
    ? {
        status: "ready",
        version,
      }
    : IDLE_APP_UPDATE_SNAPSHOT;
}
