// Named Telegram profile projection and migration helpers.

import type { AppSettings, TelegramProfileSettings } from "../types.js";

export const DEFAULT_TELEGRAM_PROFILE = "default";
const PROFILE_PATTERN = /^[a-z0-9]{1,32}$/u;
const RESERVED_PROFILE_NAMES = new Set(["main", "active"]);

export function normalizeTelegramProfileName(value: string): string {
  const profile = value.trim().toLowerCase();
  if (!PROFILE_PATTERN.test(profile) || RESERVED_PROFILE_NAMES.has(profile)) {
    throw new Error("Telegram profile names use 1–32 lowercase letters or digits; main and active are reserved.");
  }
  return profile;
}

export function telegramProfileTokenKey(profile: string): string {
  return profile === DEFAULT_TELEGRAM_PROFILE ? "telegram" : `telegram:${profile}`;
}

export function telegramProfileRuntimeFile(profile: string): string {
  return profile === DEFAULT_TELEGRAM_PROFILE
    ? "telegram-runtime.json"
    : `telegram-runtime-${profile}.json`;
}

export function telegramProfileFromSettings(settings: AppSettings, profile: string): TelegramProfileSettings {
  if (profile !== DEFAULT_TELEGRAM_PROFILE) return { ...(settings.telegramProfiles?.[profile] ?? {}) };
  return {
    enabled: settings.telegramEnabled,
    allowedUserId: settings.telegramAllowedUserId,
    providerId: settings.telegramProviderId,
    model: settings.telegramModel,
    thinkingLevel: settings.telegramThinkingLevel,
    draftPreviews: settings.telegramDraftPreviews,
    activity: settings.telegramActivity,
    rendering: settings.telegramRendering,
    voiceMode: settings.telegramVoiceMode,
    workspaceId: settings.telegramWorkspaceId,
    threadedMode: settings.telegramThreadedMode,
  };
}

export function projectTelegramProfile(settings: AppSettings, profile: string): AppSettings {
  const selected = telegramProfileFromSettings(settings, profile);
  return {
    ...settings,
    telegramEnabled: selected.enabled,
    telegramAllowedUserId: selected.allowedUserId,
    telegramProviderId: selected.providerId,
    telegramModel: selected.model,
    telegramThinkingLevel: selected.thinkingLevel,
    telegramDraftPreviews: selected.draftPreviews,
    telegramActivity: selected.activity,
    telegramRendering: selected.rendering,
    telegramVoiceMode: selected.voiceMode,
    telegramWorkspaceId: selected.workspaceId,
    telegramThreadedMode: selected.threadedMode,
  };
}

export function telegramProfilePatch(
  settings: AppSettings,
  profile: string,
  patch: Partial<AppSettings>,
): Partial<AppSettings> {
  const next: TelegramProfileSettings = {
    ...telegramProfileFromSettings(settings, profile),
    ...(patch.telegramEnabled !== undefined ? { enabled: patch.telegramEnabled } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "telegramAllowedUserId") ? { allowedUserId: patch.telegramAllowedUserId } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "telegramProviderId") ? { providerId: patch.telegramProviderId } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "telegramModel") ? { model: patch.telegramModel } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "telegramThinkingLevel") ? { thinkingLevel: patch.telegramThinkingLevel } : {}),
    ...(patch.telegramDraftPreviews !== undefined ? { draftPreviews: patch.telegramDraftPreviews } : {}),
    ...(patch.telegramActivity !== undefined ? { activity: patch.telegramActivity } : {}),
    ...(patch.telegramRendering !== undefined ? { rendering: patch.telegramRendering } : {}),
    ...(patch.telegramVoiceMode !== undefined ? { voiceMode: patch.telegramVoiceMode } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, "telegramWorkspaceId") ? { workspaceId: patch.telegramWorkspaceId } : {}),
    ...(patch.telegramThreadedMode !== undefined ? { threadedMode: patch.telegramThreadedMode } : {}),
  };
  if (profile !== DEFAULT_TELEGRAM_PROFILE) {
    return { telegramProfiles: { ...(settings.telegramProfiles ?? {}), [profile]: next } };
  }
  return {
    telegramEnabled: next.enabled,
    telegramAllowedUserId: next.allowedUserId,
    telegramProviderId: next.providerId,
    telegramModel: next.model,
    telegramThinkingLevel: next.thinkingLevel,
    telegramDraftPreviews: next.draftPreviews,
    telegramActivity: next.activity,
    telegramRendering: next.rendering,
    telegramVoiceMode: next.voiceMode,
    telegramWorkspaceId: next.workspaceId,
    telegramThreadedMode: next.threadedMode,
  };
}

export function listTelegramProfileNames(settings: AppSettings): string[] {
  return [DEFAULT_TELEGRAM_PROFILE, ...Object.keys(settings.telegramProfiles ?? {})]
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => a === DEFAULT_TELEGRAM_PROFILE ? -1 : b === DEFAULT_TELEGRAM_PROFILE ? 1 : a.localeCompare(b));
}
