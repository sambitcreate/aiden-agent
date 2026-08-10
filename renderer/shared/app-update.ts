export type AppUpdateSnapshot =
  | {
      status: "idle";
      version: null;
    }
  | {
      status: "checking";
      version: null;
    }
  | {
      status: "downloading";
      version: string;
      percent: number | null;
      transferred: number | null;
      total: number | null;
    }
  | {
      status: "ready";
      version: string;
    }
  | {
      status: "error";
      version: string | null;
      error: AppUpdateErrorKind;
    };

export type AppUpdateErrorKind = "check-failed" | "download-failed";

export type AppUpdateCheckResult =
  | {
      outcome: "up-to-date" | "ready" | "failed";
    }
  | {
      outcome: "unavailable";
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

const SEMANTIC_APP_UPDATE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

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
  if (!version || version.length > 128 || !SEMANTIC_APP_UPDATE_VERSION.test(version)) return null;
  return version;
}

function normalizeProgressNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeProgressBytes(value: unknown): number | null {
  const normalized = normalizeProgressNumber(value);
  return normalized !== null && Number.isSafeInteger(normalized) ? normalized : null;
}

export function parseAppUpdateSnapshot(value: unknown): AppUpdateSnapshot {
  if (typeof value !== "object" || value === null) return IDLE_APP_UPDATE_SNAPSHOT;
  const record = value as Record<string, unknown>;
  const version = normalizeAppUpdateVersion(record.version);
  switch (record.status) {
    case "idle":
      return IDLE_APP_UPDATE_SNAPSHOT;
    case "checking":
      return record.version === null
        ? {
            status: "checking",
            version: null,
          }
        : IDLE_APP_UPDATE_SNAPSHOT;
    case "downloading": {
      if (!version) return IDLE_APP_UPDATE_SNAPSHOT;
      const percent = normalizeProgressNumber(record.percent);
      const transferred = normalizeProgressBytes(record.transferred);
      const total = normalizeProgressBytes(record.total);
      const validBytes =
        transferred !== null && total !== null && total > 0 && transferred <= total;
      return {
        status: "downloading",
        version,
        percent: percent !== null && percent <= 100 ? percent : null,
        transferred: validBytes ? transferred : null,
        total: validBytes ? total : null,
      };
    }
    case "ready":
      return version
        ? {
            status: "ready",
            version,
          }
        : IDLE_APP_UPDATE_SNAPSHOT;
    case "error":
      return (record.error === "check-failed" || record.error === "download-failed") &&
        (record.version === null || version)
        ? {
            status: "error",
            version,
            error: record.error,
          }
        : IDLE_APP_UPDATE_SNAPSHOT;
    default:
      return IDLE_APP_UPDATE_SNAPSHOT;
  }
}
