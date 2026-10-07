/**
 * Renderer-safe status of an ACP harness provider (for example, Google
 * Antigravity): whether its runtime is installed, installing or outdated,
 * whether it is signed in, and whether chats are using it. Main projects this
 * shape; the renderer accepts nothing else.
 */

export const ACP_HARNESS_STATUS_CHANNEL = "providers:harness:changed";

export type AcpHarnessRuntimeStatus =
  | "unsupported"
  | "not_installed"
  | "installing"
  | "installed"
  | "update_available"
  | "failed";

export type AcpHarnessInstallPhase = "downloading" | "verifying" | "extracting" | "validating" | "activating";

export interface AcpHarnessStatus {
  providerId: string;
  /** Who ships the agent runtime ("Google"). */
  publisher?: string;
  runtime: {
    status: AcpHarnessRuntimeStatus;
    version?: string;
    installedVersion?: string;
    downloadBytes?: number;
    requiredBytes?: number;
    phase?: AcpHarnessInstallPhase;
    receivedBytes?: number;
    totalBytes?: number;
    message?: string;
    /** Host the runtime archive downloads from ("dl.google.com"). */
    downloadHost?: string;
  };
  signedIn: boolean;
  /** A chat is currently running on this harness. */
  busy: boolean;
}

const STATUSES: ReadonlySet<string> = new Set([
  "unsupported",
  "not_installed",
  "installing",
  "installed",
  "update_available",
  "failed",
]);
const PHASES: ReadonlySet<string> = new Set(["downloading", "verifying", "extracting", "validating", "activating"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= limit ? value : undefined;
}

function hostname(value: unknown): string | undefined {
  const host = text(value, 253);
  return host && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u.test(host) ? host : undefined;
}

export function parseAcpHarnessStatus(value: unknown): AcpHarnessStatus | undefined {
  const input = record(value);
  const runtime = record(input?.runtime);
  const providerId = text(input?.providerId, 64);
  if (!input || !runtime || !providerId || !/^[a-z0-9-]+$/u.test(providerId)) return undefined;
  if (typeof runtime.status !== "string" || !STATUSES.has(runtime.status)) return undefined;
  if (typeof input.signedIn !== "boolean" || typeof input.busy !== "boolean") return undefined;
  const phase = typeof runtime.phase === "string" && PHASES.has(runtime.phase) ? (runtime.phase as AcpHarnessInstallPhase) : undefined;
  const optional = {
    version: text(runtime.version, 32),
    installedVersion: text(runtime.installedVersion, 32),
    downloadBytes: count(runtime.downloadBytes),
    requiredBytes: count(runtime.requiredBytes),
    phase,
    receivedBytes: count(runtime.receivedBytes),
    totalBytes: count(runtime.totalBytes),
    message: text(runtime.message, 400),
    downloadHost: hostname(runtime.downloadHost),
  };
  const publisher = text(input.publisher, 64);
  return {
    providerId,
    ...(publisher ? { publisher } : {}),
    runtime: {
      status: runtime.status as AcpHarnessRuntimeStatus,
      ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
    },
    signedIn: input.signedIn,
    busy: input.busy,
  };
}

/** "111 MB", "1.2 GB". Decimal units, matching what download pages show. */
export function formatHarnessBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/** Providers whose models run inside a managed agent runtime. */
export const ACP_HARNESS_PROVIDER_IDS: readonly string[] = ["antigravity"];

export function isAcpHarnessProvider(providerId: string): boolean {
  return ACP_HARNESS_PROVIDER_IDS.includes(providerId);
}

const PHASE_COPY: Record<AcpHarnessInstallPhase, string> = {
  downloading: "Downloading",
  verifying: "Checking the download",
  extracting: "Extracting",
  validating: "Starting it once to confirm it works",
  activating: "Finishing",
};

/** One line describing the runtime, for settings rows and screen readers. */
export function harnessRuntimeSummary(status: AcpHarnessStatus["runtime"]): string {
  switch (status.status) {
    case "unsupported":
      return status.message ?? "Not available for this computer.";
    case "not_installed":
      return status.downloadBytes
        ? `Not installed. ${formatHarnessBytes(status.downloadBytes)} download${status.downloadHost ? ` from ${status.downloadHost}` : ""}.`
        : "Not installed.";
    case "installing": {
      const phase = status.phase ? PHASE_COPY[status.phase] : "Installing";
      if (status.phase === "downloading" && status.totalBytes) {
        return `${phase} ${formatHarnessBytes(status.receivedBytes ?? 0)} of ${formatHarnessBytes(status.totalBytes)}…`;
      }
      return `${phase}…`;
    }
    case "installed":
      return status.version ? `Version ${status.version} installed.` : "Installed.";
    case "update_available":
      return `Version ${status.installedVersion ?? "?"} installed. This version of Aiden needs ${status.version ?? "a newer one"}.`;
    case "failed":
      return status.message ?? "The last installation did not finish.";
  }
}

/**
 * Why sign-in is not offered yet. Agent-backed providers sign in through their
 * runtime, so sign-in waits for a current install. Nothing is said while the
 * status is still loading (the runtime section says it is checking).
 */
export function harnessSignInHint(status: AcpHarnessStatus["runtime"] | null | undefined): string | undefined {
  switch (status?.status) {
    case undefined:
    case "installed":
      return undefined;
    case "unsupported":
      return "Sign-in needs the runtime, which isn't available for this computer.";
    case "installing":
      return "You can sign in when the installation finishes.";
    case "update_available":
      return "Update the runtime above before signing in.";
    case "not_installed":
    case "failed":
      return "Install the runtime above before signing in.";
  }
}

const HARNESS_LABELS: Record<string, string> = { antigravity: "Google Antigravity" };

/**
 * Why an agent-backed provider cannot serve this surface. Agent harnesses run
 * only in chats open on this computer, where someone can answer approvals:
 * never in Bots, scheduled tasks, Telegram, subagents, or phone-started runs.
 */
export function acpHarnessUnavailableReason(providerId: string | undefined | null): string | undefined {
  if (!providerId || !isAcpHarnessProvider(providerId)) return undefined;
  const label = HARNESS_LABELS[providerId] ?? "This provider";
  return `${label} runs only in chats you have open on this computer. Choose another model here.`;
}

/**
 * The app's last-used selection, unless it is agent-backed. Unattended
 * surfaces (schedules, Telegram, dictation cleanup) fall back to it and must
 * never inherit a provider that cannot run without someone watching.
 */
export function unattendedFallbackProviderId(lastProviderId: string | undefined | null): string | undefined {
  return lastProviderId && !isAcpHarnessProvider(lastProviderId) ? lastProviderId : undefined;
}
