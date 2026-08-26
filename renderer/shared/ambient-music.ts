export type AmbientMusicModelId = "mrt2_small" | "mrt2_base";

export interface AmbientMusicPromptStyle {
  id: string;
  text: string;
  weight: number;
}

export interface AmbientMusicConfigV1 {
  version: 1;
  selectedModel: AmbientMusicModelId;
  prompts: AmbientMusicPromptStyle[];
  volumeDb: number;
  variation: number;
  drumless: boolean;
}

export const DEFAULT_AMBIENT_MUSIC_CONFIG: AmbientMusicConfigV1 = {
  version: 1,
  selectedModel: "mrt2_small",
  prompts: [{ id: "soft-focus", text: "soft focus ambient, warm synthesizer, no vocals", weight: 1 }],
  volumeDb: -18,
  variation: 0,
  drumless: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseAmbientMusicConfig(value: unknown): AmbientMusicConfigV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (value.selectedModel !== "mrt2_small" && value.selectedModel !== "mrt2_base") return undefined;
  if (
    !Array.isArray(value.prompts) ||
    value.prompts.length < 1 ||
    value.prompts.length > 6 ||
    typeof value.volumeDb !== "number" ||
    !Number.isFinite(value.volumeDb) ||
    value.volumeDb < -60 ||
    value.volumeDb > 0 ||
    typeof value.variation !== "number" ||
    !Number.isFinite(value.variation) ||
    value.variation < 0 ||
    value.variation > 1 ||
    typeof value.drumless !== "boolean"
  ) return undefined;
  const prompts: AmbientMusicPromptStyle[] = [];
  const ids = new Set<string>();
  for (const prompt of value.prompts) {
    if (!isRecord(prompt)) return undefined;
    if (
      typeof prompt.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(prompt.id) ||
      ids.has(prompt.id) ||
      typeof prompt.text !== "string" ||
      utf8Bytes(prompt.text.trim()) < 1 ||
      utf8Bytes(prompt.text.trim()) > 200 ||
      Array.from(prompt.text.trim()).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      }) ||
      typeof prompt.weight !== "number" ||
      !Number.isFinite(prompt.weight) ||
      prompt.weight < 0 ||
      prompt.weight > 1
    ) return undefined;
    ids.add(prompt.id);
    prompts.push({ id: prompt.id, text: prompt.text.trim(), weight: prompt.weight });
  }
  const total = prompts.reduce((sum, prompt) => sum + prompt.weight, 0);
  if (total <= 0) return undefined;
  return {
    version: 1,
    selectedModel: value.selectedModel,
    prompts: prompts.map((prompt) => ({ ...prompt, weight: prompt.weight / total })),
    volumeDb: value.volumeDb,
    variation: value.variation,
    drumless: value.drumless,
  };
}
export type AmbientMusicModelInstallState =
  | "not_installed"
  | "downloading"
  | "verifying"
  | "ready"
  | "needs_repair"
  | "failed";

export interface AmbientMusicModelStatus {
  model: AmbientMusicModelId;
  label: string;
  recommended: boolean;
  state: AmbientMusicModelInstallState;
  downloadBytes: number;
  installedBytes: number;
  additionalDownloadBytes: number;
  reclaimableBytes: number;
  progress?: {
    downloadedBytes: number;
    totalBytes: number;
    currentFile: number;
    fileCount: number;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface AmbientMusicBaseBenchmarkResult {
  status: "passed" | "failed";
  measuredAt: string;
  p50FrameMs: number;
  p95FrameMs: number;
  droppedFrames: number;
  minimumBufferRatio: number;
}

export interface AmbientMusicDegradation {
  code: "realtime_pressure";
  since: string;
  frameMs: number;
  bufferRatio: number;
  droppedFramesSinceLastSample: number;
}

export type AmbientMusicSupportReason =
  | "requires_macos_14"
  | "requires_apple_silicon"
  | "unsupported_platform";

export interface AmbientMusicFeatureSnapshot {
  revision: number;
  supported: boolean;
  supportReason?: AmbientMusicSupportReason;
  helper: AmbientMusicHelperState;
  playback: AmbientMusicPlaybackState;
  /** True while Base qualification is running with native output force-silent. */
  benchmarking?: boolean;
  selectedModel?: AmbientMusicModelId;
  loadedModel?: AmbientMusicModelId;
  promptReady: boolean;
  models: AmbientMusicModelStatus[];
  storage: {
    sharedBytes: number;
    availableBytes?: number;
    locationLabel: "Aiden application data";
  };
  baseBenchmark?: AmbientMusicBaseBenchmarkResult;
  metrics?: AmbientMusicMetrics;
  degradation?: AmbientMusicDegradation;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface AmbientMusicApplyResult {
  snapshot: AmbientMusicFeatureSnapshot;
  config: AmbientMusicConfigV1;
}
export type AmbientMusicPlaybackState = "stopped" | "loading" | "paused" | "playing" | "error";
export type AmbientMusicHelperState =
  | "unsupported"
  | "missing"
  | "stopped"
  | "starting"
  | "ready"
  | "crashed";

export const AMBIENT_MUSIC_VISUALIZER_BAND_COUNT = 18;

export interface AmbientMusicMetrics {
  transformerMs: number;
  frameMs: number;
  bufferAvailable: number;
  bufferCapacity: number;
  droppedFrames: number;
  /** Normalized post-gain energy from the helper's generated audio filter bank. */
  visualizerBands?: number[];
}

export interface AmbientMusicSnapshot {
  revision: number;
  supported: boolean;
  supportReason?: AmbientMusicSupportReason;
  helper: AmbientMusicHelperState;
  playback: AmbientMusicPlaybackState;
  model?: AmbientMusicModelId;
  promptReady: boolean;
  metrics?: AmbientMusicMetrics;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
