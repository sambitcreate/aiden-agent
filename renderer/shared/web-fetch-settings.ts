/**
 * Renderer-safe `web_fetch` settings: whether the agent may read public web
 * pages, and whether extract mode is on with which extraction model.
 *
 * Keys never appear here. The Cloudflare key lives in the main-owned Web
 * Search key pool under `cloudflare-workers-ai`; the account ID is ordinary
 * configuration.
 */

import type { WebExtractKeyPoolId } from "./web-search-key-pool.js";

export const WEB_FETCH_SETTINGS_VERSION = 1 as const;

export const WEB_EXTRACT_MODEL_IDS = Object.freeze(["cloudflare-clairic"] as const);
export type WebExtractModelId = (typeof WEB_EXTRACT_MODEL_IDS)[number];

export interface WebExtractModelDefinition {
  readonly id: WebExtractModelId;
  readonly label: string;
  /** Who runs the model, for the privacy line in Settings. */
  readonly vendor: string;
  /** The key pool that holds this model's API keys. */
  readonly credentialId: WebExtractKeyPoolId;
  readonly accountIdLabel: string;
  readonly keyHelpUrl: string;
}

export const WEB_EXTRACT_MODELS: Readonly<Record<WebExtractModelId, WebExtractModelDefinition>> =
  Object.freeze({
    "cloudflare-clairic": Object.freeze({
      id: "cloudflare-clairic",
      label: "Cloudflare Workers AI · Clairic",
      vendor: "Cloudflare",
      credentialId: "cloudflare-workers-ai",
      accountIdLabel: "Cloudflare account ID",
      keyHelpUrl: "https://developers.cloudflare.com/workers-ai/get-started/rest-api/",
    }),
  });

export interface WebFetchSettingsV1 {
  readonly version: typeof WEB_FETCH_SETTINGS_VERSION;
  /** `web_fetch` reads public pages in attended chats while Web Search is on. */
  readonly enabled: boolean;
  readonly extract: {
    /** Opt-in. It takes effect only while its model is set up. */
    readonly enabled: boolean;
    readonly model: WebExtractModelId;
    readonly accountId?: string;
  };
}

/** Cloudflare account IDs are 32 hexadecimal characters. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;

export function normalizeWebExtractAccountId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return ACCOUNT_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function defaultWebFetchSettings(): WebFetchSettingsV1 {
  return {
    version: WEB_FETCH_SETTINGS_VERSION,
    enabled: true,
    extract: { enabled: false, model: "cloudflare-clairic" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWebExtractModelId(value: unknown): value is WebExtractModelId {
  return typeof value === "string" && (WEB_EXTRACT_MODEL_IDS as readonly string[]).includes(value);
}

/** Strictly parse a stored document; anything else (or a newer version) is undefined. */
export function parseWebFetchSettings(value: unknown): WebFetchSettingsV1 | undefined {
  if (!isRecord(value) || value.version !== WEB_FETCH_SETTINGS_VERSION) return undefined;
  if (typeof value.enabled !== "boolean" || !isRecord(value.extract)) return undefined;
  const extract = value.extract;
  if (typeof extract.enabled !== "boolean" || !isWebExtractModelId(extract.model)) return undefined;
  const accountId =
    extract.accountId === undefined ? undefined : normalizeWebExtractAccountId(extract.accountId);
  if (extract.accountId !== undefined && accountId !== extract.accountId) return undefined;
  return {
    version: WEB_FETCH_SETTINGS_VERSION,
    enabled: value.enabled,
    extract: {
      enabled: extract.enabled,
      model: extract.model,
      ...(accountId === undefined ? {} : { accountId }),
    },
  };
}

/** Whether the extraction model has what it needs to run. */
export interface WebExtractReadiness {
  readonly hasAccountId: boolean;
  readonly keyCount: number;
}

export function webExtractReady(readiness: WebExtractReadiness): boolean {
  return readiness.hasAccountId && readiness.keyCount > 0;
}

/** What Settings shows. Never holds a key. */
export interface WebFetchRendererSnapshot {
  readonly settings: WebFetchSettingsV1;
  /** `web_fetch` follows the Web Search switch. */
  readonly webSearchEnabled: boolean;
  readonly extract: WebExtractReadiness & {
    readonly ready: boolean;
    /** Extract mode is on and its model is set up, so the agent sees it. */
    readonly active: boolean;
  };
}

export function webFetchRendererSnapshot(input: {
  readonly settings: WebFetchSettingsV1;
  readonly webSearchEnabled: boolean;
  readonly keyCount: number;
}): WebFetchRendererSnapshot {
  const readiness = {
    hasAccountId: input.settings.extract.accountId !== undefined,
    keyCount: input.keyCount,
  };
  const ready = webExtractReady(readiness);
  return {
    settings: input.settings,
    webSearchEnabled: input.webSearchEnabled,
    extract: { ...readiness, ready, active: input.settings.extract.enabled && ready },
  };
}
