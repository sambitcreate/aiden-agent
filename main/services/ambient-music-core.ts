import type {
  AmbientMusicModelId,
  AmbientMusicPlaybackState,
} from "../../renderer/shared/ambient-music.js";

export const AMBIENT_MUSIC_MAX_PROMPTS = 6;
export const AMBIENT_MUSIC_MAX_PROMPT_BYTES = 500;
export const AMBIENT_MUSIC_MIN_VOLUME_DB = -60;
export const AMBIENT_MUSIC_MAX_VOLUME_DB = 0;

export class AmbientMusicValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AmbientMusicValidationError";
  }
}

export interface AmbientMusicPromptMix {
  prompts: string[];
  weights: number[];
}

export interface AmbientMusicPlaybackProjection {
  state: Extract<AmbientMusicPlaybackState, "stopped" | "paused" | "playing">;
  revision: number;
}

export function validateAmbientMusicModel(model: unknown): AmbientMusicModelId {
  if (model !== "mrt2_small" && model !== "mrt2_base") {
    throw new AmbientMusicValidationError("invalid_model", "Choose a supported Ambient Music model.");
  }
  return model;
}

export function validateAmbientMusicPromptMix(
  rawPrompts: unknown,
  rawWeights: unknown,
): AmbientMusicPromptMix {
  if (
    !Array.isArray(rawPrompts) ||
    rawPrompts.length < 1 ||
    rawPrompts.length > AMBIENT_MUSIC_MAX_PROMPTS ||
    !Array.isArray(rawWeights) ||
    rawWeights.length !== rawPrompts.length
  ) {
    throw new AmbientMusicValidationError(
      "invalid_prompt_mix",
      "Provide one to six prompts and one weight for each prompt.",
    );
  }
  const prompts = rawPrompts.map((value) => {
    if (typeof value !== "string") {
      throw new AmbientMusicValidationError("invalid_prompt", "Ambient Music prompts must be text.");
    }
    const prompt = value.trim();
    if (
      !prompt ||
      Buffer.byteLength(prompt, "utf8") > AMBIENT_MUSIC_MAX_PROMPT_BYTES ||
      Array.from(prompt).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw new AmbientMusicValidationError(
        "invalid_prompt",
        "Each Ambient Music prompt must be non-empty, safe text of at most 500 bytes.",
      );
    }
    return prompt;
  });
  const weights = rawWeights.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new AmbientMusicValidationError(
        "invalid_weights",
        "Ambient Music weights must be finite numbers between zero and one.",
      );
    }
    return value;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    throw new AmbientMusicValidationError("invalid_weights", "At least one Ambient Music weight must be positive.");
  }
  return { prompts, weights: weights.map((weight) => weight / total) };
}

export function validateAmbientMusicWeights(rawWeights: unknown, expectedCount?: number): number[] {
  if (
    !Array.isArray(rawWeights) ||
    rawWeights.length < 1 ||
    rawWeights.length > AMBIENT_MUSIC_MAX_PROMPTS ||
    (expectedCount !== undefined && rawWeights.length !== expectedCount)
  ) {
    throw new AmbientMusicValidationError("invalid_weights", "Provide one valid weight for each Ambient Music prompt.");
  }
  const values = rawWeights.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new AmbientMusicValidationError(
        "invalid_weights",
        "Ambient Music weights must be finite numbers between zero and one.",
      );
    }
    return value;
  });
  const total = values.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    throw new AmbientMusicValidationError("invalid_weights", "At least one Ambient Music weight must be positive.");
  }
  return values.map((weight) => weight / total);
}

export function validateAmbientMusicVolume(decibels: unknown): number {
  if (
    typeof decibels !== "number" ||
    !Number.isFinite(decibels) ||
    decibels < AMBIENT_MUSIC_MIN_VOLUME_DB ||
    decibels > AMBIENT_MUSIC_MAX_VOLUME_DB
  ) {
    throw new AmbientMusicValidationError(
      "invalid_volume",
      `Ambient Music volume must be between ${AMBIENT_MUSIC_MIN_VOLUME_DB} dB and ${AMBIENT_MUSIC_MAX_VOLUME_DB} dB.`,
    );
  }
  return decibels;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAmbientMusicPlaybackProjection(value: unknown): AmbientMusicPlaybackProjection {
  if (!isObject(value)) {
    throw new AmbientMusicValidationError("invalid_playback_projection", "The helper omitted playback state.");
  }
  const state = value.state;
  const revision = value.revision;
  if (
    (state !== "stopped" && state !== "paused" && state !== "playing") ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new AmbientMusicValidationError("invalid_playback_projection", "The helper returned invalid playback state.");
  }
  return { state, revision: revision as number };
}

export function shouldApplyAmbientMusicPlayback(
  currentRevision: number,
  projection: AmbientMusicPlaybackProjection,
): boolean {
  return projection.revision >= currentRevision;
}
