import type {
  FoundationModelsConnectionStatus,
  FoundationModelsConnectionState,
} from "./types.js";

export const FOUNDATION_MODELS_PROTOCOL_VERSION = 1;
const STATUS_TIMEOUT_MS = 5_000;
const GENERATION_TIMEOUT_MS = 15_000;
const STABLE_STATUS_TTL_MS = 30_000;
const PREPARING_STATUS_TTL_MS = 5_000;

export type NativeFoundationModelsMethod = "availability" | "generateTitle";

export interface NativeFoundationModelsRequest {
  version: number;
  method: NativeFoundationModelsMethod;
  prompt?: string;
}

export interface NativeFoundationModelsResponse {
  version: number;
  ok: boolean;
  result?: {
    state?: "ready" | "device_not_eligible" | "apple_intelligence_disabled" | "model_preparing" | "unavailable";
    title?: string;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface NativeFoundationModelsRunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export type NativeFoundationModelsRequestRunner = (
  request: NativeFoundationModelsRequest,
  options: NativeFoundationModelsRunOptions,
) => Promise<NativeFoundationModelsResponse>;

interface ConnectionDependencies {
  platform: NodeJS.Platform;
  arch: string;
  systemVersion: string;
  now: () => number;
  runRequest: NativeFoundationModelsRequestRunner;
}

export class FoundationModelsConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "FoundationModelsConnectionError";
  }
}

function connectionStatus(
  state: FoundationModelsConnectionState,
  detail: string,
  retryable = false,
): FoundationModelsConnectionStatus {
  return {
    id: "apple-foundation-models",
    label: "Apple Foundation Models",
    state,
    detail,
    local: true,
    titleOnly: true,
    retryable,
  };
}

function systemVersionMajor(value: string): number | null {
  const match = /^(\d+)/.exec(value.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

export function platformFoundationModelsStatus(input: {
  platform: NodeJS.Platform;
  arch: string;
  systemVersion: string;
}): FoundationModelsConnectionStatus | null | undefined {
  if (input.platform !== "darwin") return null;
  const major = systemVersionMajor(input.systemVersion);
  if (major === null || major < 26) {
    return connectionStatus(
      "unsupported_os",
      "Apple Foundation Models require macOS 26 or later.",
    );
  }
  if (input.arch !== "arm64") {
    return connectionStatus(
      "device_not_eligible",
      "Apple Foundation Models require an Apple Intelligence-capable Mac.",
    );
  }
  return undefined;
}

function mapNativeAvailability(
  state: NonNullable<NativeFoundationModelsResponse["result"]>["state"],
): FoundationModelsConnectionStatus {
  switch (state) {
    case "ready":
      return connectionStatus("ready", "Ready to create chat titles on this Mac.");
    case "device_not_eligible":
      return connectionStatus(
        "device_not_eligible",
        "This Mac does not support Apple Intelligence.",
      );
    case "apple_intelligence_disabled":
      return connectionStatus(
        "apple_intelligence_disabled",
        "Turn on Apple Intelligence in System Settings to use on-device titles.",
      );
    case "model_preparing":
      return connectionStatus(
        "model_preparing",
        "The on-device model is still downloading or preparing.",
        true,
      );
    case "unavailable":
    case undefined:
      return connectionStatus("unavailable", "Apple Foundation Models are unavailable.");
  }
}

export function parseFoundationModelsResponse(value: string): NativeFoundationModelsResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new FoundationModelsConnectionError(
      "invalid_response",
      "The native helper returned invalid JSON.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new FoundationModelsConnectionError(
      "invalid_response",
      "The native helper returned an invalid response.",
    );
  }
  const response = parsed as Record<string, unknown>;
  if (response.version !== FOUNDATION_MODELS_PROTOCOL_VERSION || typeof response.ok !== "boolean") {
    throw new FoundationModelsConnectionError(
      "invalid_response",
      "The native helper protocol did not match this version of Aiden.",
    );
  }
  if (response.ok) {
    if (typeof response.result !== "object" || response.result === null) {
      throw new FoundationModelsConnectionError(
        "invalid_response",
        "The native helper returned no result.",
      );
    }
    const result = response.result as Record<string, unknown>;
    const states = new Set([
      "ready",
      "device_not_eligible",
      "apple_intelligence_disabled",
      "model_preparing",
      "unavailable",
    ]);
    if (result.state !== undefined && (typeof result.state !== "string" || !states.has(result.state))) {
      throw new FoundationModelsConnectionError(
        "invalid_response",
        "The native helper returned an invalid availability state.",
      );
    }
    if (result.title !== undefined && typeof result.title !== "string") {
      throw new FoundationModelsConnectionError(
        "invalid_response",
        "The native helper returned an invalid title.",
      );
    }
    if (result.state === undefined && result.title === undefined) {
      throw new FoundationModelsConnectionError(
        "invalid_response",
        "The native helper returned an empty result.",
      );
    }
  } else {
    if (typeof response.error !== "object" || response.error === null) {
      throw new FoundationModelsConnectionError(
        "invalid_response",
        "The native helper returned no error details.",
      );
    }
    const error = response.error as Record<string, unknown>;
    if (
      typeof error.code !== "string" ||
      typeof error.message !== "string" ||
      typeof error.retryable !== "boolean"
    ) {
      throw new FoundationModelsConnectionError(
        "invalid_response",
        "The native helper returned invalid error details.",
      );
    }
  }
  return parsed as NativeFoundationModelsResponse;
}

export function createFoundationModelsConnection(deps: ConnectionDependencies) {
  let cachedStatus: { value: FoundationModelsConnectionStatus | null; expiresAt: number } | null = null;
  let statusInFlight: Promise<FoundationModelsConnectionStatus | null> | null = null;

  const platformStatus = () =>
    platformFoundationModelsStatus({
      platform: deps.platform,
      arch: deps.arch,
      systemVersion: deps.systemVersion,
    });

  const loadStatus = async (): Promise<FoundationModelsConnectionStatus | null> => {
    const gate = platformStatus();
    if (gate !== undefined) return gate;
    try {
      const response = await deps.runRequest(
        { version: FOUNDATION_MODELS_PROTOCOL_VERSION, method: "availability" },
        { timeoutMs: STATUS_TIMEOUT_MS },
      );
      if (!response.ok) {
        return connectionStatus(
          "error",
          response.error?.message || "Apple Foundation Models could not be checked.",
          response.error?.retryable ?? false,
        );
      }
      return mapNativeAvailability(response.result?.state);
    } catch (error) {
      const code = error instanceof FoundationModelsConnectionError ? error.code : "helper_failed";
      return connectionStatus(
        code === "helper_missing" ? "helper_unavailable" : "error",
        code === "helper_missing"
          ? "The native helper is not included in this build."
          : "Apple Foundation Models could not be checked.",
        error instanceof FoundationModelsConnectionError ? error.retryable : false,
      );
    }
  };

  return {
    async status(options: { force?: boolean } = {}): Promise<FoundationModelsConnectionStatus | null> {
      const gate = platformStatus();
      if (gate !== undefined) return gate;
      if (!options.force && cachedStatus && deps.now() < cachedStatus.expiresAt) {
        return cachedStatus.value;
      }
      if (statusInFlight) return statusInFlight;
      statusInFlight = loadStatus()
        .then((value) => {
          const ttl =
            value?.state === "model_preparing" || value?.retryable
              ? PREPARING_STATUS_TTL_MS
              : STABLE_STATUS_TTL_MS;
          cachedStatus = { value, expiresAt: deps.now() + ttl };
          return value;
        })
        .finally(() => {
          statusInFlight = null;
        });
      return statusInFlight;
    },

    async generateTitle(prompt: string, signal?: AbortSignal): Promise<string> {
      const gate = platformStatus();
      if (gate === null) {
        throw new FoundationModelsConnectionError(
          "unsupported_platform",
          "Apple Foundation Models are available only on macOS.",
        );
      }
      if (gate) {
        throw new FoundationModelsConnectionError(gate.state, gate.detail, gate.retryable);
      }
      let response: NativeFoundationModelsResponse;
      try {
        response = await deps.runRequest(
          {
            version: FOUNDATION_MODELS_PROTOCOL_VERSION,
            method: "generateTitle",
            prompt,
          },
          { timeoutMs: GENERATION_TIMEOUT_MS, signal },
        );
      } catch (error) {
        if (!(error instanceof FoundationModelsConnectionError && error.code === "cancelled")) {
          cachedStatus = {
            value: connectionStatus(
              "error",
              "Apple Foundation Models could not generate a title.",
              error instanceof FoundationModelsConnectionError ? error.retryable : false,
            ),
            expiresAt: deps.now() + PREPARING_STATUS_TTL_MS,
          };
        }
        throw error;
      }
      if (!response.ok) {
        if (
          response.error?.code === "model_unavailable" ||
          response.error?.code === "assets_unavailable"
        ) {
          cachedStatus = {
            value: connectionStatus(
              "unavailable",
              response.error.message,
              response.error.retryable,
            ),
            expiresAt: deps.now() + PREPARING_STATUS_TTL_MS,
          };
        }
        throw new FoundationModelsConnectionError(
          response.error?.code ?? "generation_failed",
          response.error?.message ?? "Apple Foundation Models could not generate a title.",
          response.error?.retryable ?? false,
        );
      }
      const title = response.result?.title?.trim();
      if (!title) {
        throw new FoundationModelsConnectionError(
          "invalid_response",
          "Apple Foundation Models returned an empty title.",
        );
      }
      return title;
    },

    clearStatus(): void {
      cachedStatus = null;
    },
  };
}
