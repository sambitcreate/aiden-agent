import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseCustomModelOptions } from "../../renderer/shared/custom-model-options.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { normalizeProviderBaseUrl } from "./models.js";
import type { StoredProvider } from "./types.js";

export const AIDEN_REMOTE_PROVIDER_CREATE_FEATURE = "providers-create-v1";

export interface RemoteProviderCreation {
  label: string;
  baseUrl: string;
  kind: "openai" | "anthropic";
  deployment: "local" | "hosted";
  needsKey: boolean;
  apiKey?: string;
  models: Array<{ id: string; vision: boolean; reasoning: boolean; toolCall: boolean; contextLength?: number; outputLimit?: number; maxImages?: number }>;
  confirmedForeground: true;
}

export function parseRemoteProviderCreation(input: unknown): RemoteProviderCreation {
  const fail = (): never => { throw new AidenRemoteServiceError("invalid_request", "Enter a valid provider name, endpoint, models, and authentication settings.", 400); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const value = input as Record<string, unknown>;
  const required = ["label", "baseUrl", "kind", "deployment", "needsKey", "models", "confirmedForeground"];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some((key) => ![...required, "apiKey"].includes(key))) return fail();
  const bounded = (text: unknown, max: number): text is string => typeof text === "string" && text.trim().length > 0 && text.length <= max && !Array.from(text).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!bounded(value.label, 120) || !bounded(value.baseUrl, 2048) || !["openai", "anthropic"].includes(String(value.kind)) || !["local", "hosted"].includes(String(value.deployment)) || typeof value.needsKey !== "boolean" || value.confirmedForeground !== true) return fail();
  if (value.needsKey ? !bounded(value.apiKey, 4096) : value.apiKey !== undefined) return fail();
  if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 32) return fail();
  const models = value.models.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
    const model = raw as Record<string, unknown>;
    if (!bounded(model.id, 128) || ["vision", "reasoning", "toolCall"].some((key) => typeof model[key] !== "boolean") || Object.keys(model).some((key) => !["id", "vision", "reasoning", "toolCall", "contextLength", "outputLimit", "maxImages"].includes(key))) return fail();
    try {
      const { id, ...options } = model;
      const parsed = parseCustomModelOptions(options);
      if ((parsed?.contextLength ?? 1) > 1_000_000_000 || (parsed?.outputLimit ?? 1) > 1_000_000_000 || (parsed?.maxImages ?? 0) > 100) return fail();
      if (parsed?.contextLength && parsed.outputLimit && parsed.outputLimit > parsed.contextLength) return fail();
      return { id: String(id).trim(), ...parsed } as RemoteProviderCreation["models"][number];
    } catch { return fail(); }
  });
  if (new Set(models.map((model) => model.id)).size !== models.length) return fail();
  let baseUrl: string;
  try { baseUrl = normalizeProviderBaseUrl(value.baseUrl); } catch { return fail(); }
  return { label: value.label.trim(), baseUrl, kind: value.kind as RemoteProviderCreation["kind"], deployment: value.deployment as RemoteProviderCreation["deployment"], needsKey: value.needsKey, ...(value.needsKey ? { apiKey: String(value.apiKey).trim() } : {}), models, confirmedForeground: true };
}

/** Create-only: remote requests cannot redirect or overwrite an existing credential. */
export class AidenRemoteProviderService {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly dependencies: {
    get(id: string): Promise<StoredProvider | undefined>;
    save(provider: StoredProvider, key: string | null, isCurrent: () => boolean): Promise<StoredProvider>;
    changed(): void;
  }) {}

  create(deviceId: string, key: string, input: unknown, isCurrent: () => boolean = () => true) {
    if (!/^[\x21-\x7e]{16,128}$/u.test(key)) throw new AidenRemoteServiceError("invalid_request", "A stable creation key is required.", 400);
    const request = parseRemoteProviderCreation(input);
    const id = `custom:remote-${createHash("sha256").update(JSON.stringify([deviceId, key])).digest("hex").slice(0, 32)}`;
    const provider: StoredProvider = {
      id, label: request.label, baseUrl: request.baseUrl, kind: request.kind, deployment: request.deployment,
      needsKey: request.needsKey, isPreset: false, models: request.models.map((model) => model.id), defaultModel: request.models[0]!.id,
      modelMetadata: Object.fromEntries(request.models.map(({ id: modelId, ...overrides }) => [modelId, { source: "provider", manuallyAdded: true, overrides }])),
    };
    const run = this.tail.then(async () => {
      if (!isCurrent()) throw new AidenRemoteServiceError("credential_revoked", "This device is no longer authorized.", 403);
      const existing = await this.dependencies.get(id);
      if (existing) {
        const fields = (value: StoredProvider) => [value.id, value.label, value.baseUrl, value.kind, value.deployment, value.needsKey, value.models, value.defaultModel, value.modelMetadata];
        if (!isDeepStrictEqual(fields(existing), fields(provider))) throw new AidenRemoteServiceError("idempotency_conflict", "This creation key already belongs to a different provider. Refresh your providers before trying again.", 409);
        // A lost receipt can be recovered after a restart. Never rotate a key on replay.
        return { id: existing.id, label: existing.label, models: existing.models };
      }
      const saved = await this.dependencies.save(provider, request.apiKey ?? null, isCurrent);
      this.dependencies.changed();
      return { id: saved.id, label: saved.label, models: saved.models };
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
