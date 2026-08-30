import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  BOT_CAPABILITY_LIMITS,
  BOT_FULL_ACCESS_NOTICE_VERSION,
  isBoundedBotText,
  isPathSafeBotCapabilityId,
  type BotCapabilityCatalog,
  type BotCapabilityOption,
  type BotFileScopeKind,
  type BotFileScopeOption,
  type BotModelOption,
  type BotNoticeStatus,
  type BotProviderOption,
} from "../../renderer/shared/bot-capabilities.js";

/** Leave room for the authenticated response envelope below the 1 MiB wire ceiling. */
export const BOT_CAPABILITY_CATALOG_MAX_PUBLIC_BYTES = 900 * 1024;

export const BOT_CAPABILITY_PRIVATE_LIMITS = Object.freeze({
  sourceIdChars: 512,
  connectionTools: 256,
  aggregateConnectionTools: 4_096,
  toolNameChars: 256,
});

export const BOT_ORDINARY_CAPABILITY_KINDS = [
  "web",
  "browser",
  "computer_use",
  "schedules",
  "subagents",
] as const;

export type BotOrdinaryCapabilityKind = (typeof BOT_ORDINARY_CAPABILITY_KINDS)[number];

const EXACT_SHA256 = /^[a-f0-9]{64}$/u;
const PRIVATE_PUBLIC_KEYS = new Set([
  "credential",
  "credentials",
  "secret",
  "secrets",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "header",
  "headers",
  "endpoint",
  "path",
  "prompt",
  "instructions",
  "openinggreeting",
  "argument",
  "arguments",
  "args",
  "toolargument",
  "toolarguments",
  "toolargs",
  "result",
  "results",
  "toolresult",
  "toolresults",
  "reasoning",
  "reasoningcontent",
  "authorization",
  "credentialdigest",
  "providerfingerprint",
  "mcpserverbindings",
  "folderpath",
  "repositorypath",
  "worktreepath",
  "worktreegitdir",
  "ownershiptoken",
  "worktreedevice",
  "worktreeinode",
  "createdfromhead",
  "canonicalpath",
  "absolutepath",
  "scriptpath",
  "managedhomepath",
  "managedworkspacepath",
  "workspacepath",
  "bothomepath",
  "systemprompt",
  "skillcontent",
  "skillcontents",
  "skillpath",
  "skillpaths",
  "providercredential",
  "mcpcredential",
  "connectioncredential",
  "authorizationheader",
  "providerheaders",
  "mcpheaders",
  "connectionheaders",
  "providerapikey",
  "mcpapikey",
  "connectionapikey",
  "credentialmaterial",
  "assetfilename",
  "avatarassetfilename",
  "temporaryasseturl",
  "temporaryurl",
  "environment",
  "stdout",
  "stderr",
  "fingerprint",
]);

const UNSAFE_PUBLIC_TEXT = [
  /(?:^|[\s('"`])(?:~\/|\/(?:Users|Volumes|private|var|tmp|home|etc)\/)/u,
  /(?:^|\s)[A-Za-z]:[\\/]/u,
  /\b(?:file|https?):\/\//iu,
  /-----BEGIN [A-Z ]+-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password)\s*[:=]/iu,
];

export interface BotProviderModelInventory {
  sourceId: string;
  label: string;
  available: boolean;
  supportsImages?: boolean;
  /** Main-only digest covering the exact model identity/runtime metadata. */
  modelFingerprint: string;
}

export interface BotProviderInventory {
  sourceId: string;
  label: string;
  available: boolean;
  /** Main-only digest covering recipient endpoint, auth revision, and connection identity. */
  connectionFingerprint: string;
  models: BotProviderModelInventory[];
}

export interface BotFileScopeInventory {
  sourceId: string;
  label: string;
  description?: string;
  available: boolean;
  kind: BotFileScopeKind;
  /** Main-only digest covering the exact root/policy/filesystem identity. */
  scopeFingerprint: string;
}

export interface BotShellInventory {
  available: boolean;
  /** Main-only digest covering the enabled shell/runtime policy. */
  shellFingerprint: string;
}

export interface BotMcpToolInventory {
  name: string;
  inputSchemaFingerprint: string;
  outputSchemaFingerprint: string;
  effect: "read" | "mutating";
  /** Unknown effects must already be projected as the conservative mutating profile. */
  effectFingerprint: string;
}

export interface BotConnectionInventory {
  sourceId: string;
  label: string;
  description?: string;
  available: boolean;
  /** Main-only digest covering transport configuration and credential revision. */
  connectionFingerprint: string;
  tools: BotMcpToolInventory[];
}

export interface BotSkillInventory {
  sourceId: string;
  label: string;
  description?: string;
  available: boolean;
  /** Stable main-owned identity; never a path or a renderer invocation id. */
  identityFingerprint: string;
  /** Digest of the exact skill instructions and source identity. */
  contentFingerprint: string;
}

export interface BotOrdinaryCapabilityInventory {
  kind: BotOrdinaryCapabilityKind;
  label: string;
  description?: string;
  available: boolean;
  capabilityFingerprint: string;
}

export interface BotCapabilityInventory {
  providers: BotProviderInventory[];
  fileScopes: BotFileScopeInventory[];
  shell: BotShellInventory;
  connections: BotConnectionInventory[];
  skills: BotSkillInventory[];
  otherCapabilities: BotOrdinaryCapabilityInventory[];
}

export type BotCapabilityOpaqueNamespace =
  | "provider"
  | "model"
  | "file"
  | "connection"
  | "skill"
  | "other";

/** Mint a public selection id. Exact fingerprints are required and stored privately; current minting follows source identity so live fact churn does not rotate checkboxes. */
export type BotCapabilityOpaqueIdMint = (
  namespace: BotCapabilityOpaqueNamespace,
  sourceIdentity: string,
  exactFingerprint: string,
) => string;

export interface BotCatalogModelResource {
  option: BotModelOption;
  sourceId: string;
  modelFingerprint: string;
  exactFingerprint: string;
}

export interface BotCatalogProviderResource {
  option: BotProviderOption;
  sourceId: string;
  connectionFingerprint: string;
  exactFingerprint: string;
  models: BotCatalogModelResource[];
}

export interface BotCatalogFileScopeResource {
  option: BotFileScopeOption;
  sourceId: string;
  scopeFingerprint: string;
  exactFingerprint: string;
}

export interface BotCatalogShellResource {
  available: boolean;
  shellFingerprint: string;
  exactFingerprint: string;
}

export interface BotCatalogMcpToolResource extends BotMcpToolInventory {
  exactFingerprint: string;
}

export interface BotCatalogConnectionResource {
  option: BotCapabilityOption;
  sourceId: string;
  connectionFingerprint: string;
  toolsetFingerprint: string;
  exactFingerprint: string;
  tools: BotCatalogMcpToolResource[];
}

export interface BotCatalogSkillResource {
  option: BotCapabilityOption;
  sourceId: string;
  identityFingerprint: string;
  contentFingerprint: string;
  exactFingerprint: string;
}

export interface BotCatalogOrdinaryCapabilityResource {
  option: BotCapabilityOption;
  kind: BotOrdinaryCapabilityKind;
  capabilityFingerprint: string;
  exactFingerprint: string;
}

export interface BotCapabilityCatalogResources {
  providers: BotCatalogProviderResource[];
  fileScopes: BotCatalogFileScopeResource[];
  shell: BotCatalogShellResource;
  connections: BotCatalogConnectionResource[];
  skills: BotCatalogSkillResource[];
  otherCapabilities: BotCatalogOrdinaryCapabilityResource[];
}

export interface BotCapabilityCatalogSnapshot {
  catalog: BotCapabilityCatalog;
  /** Main-only exact facts. This object must never cross IPC or Remote API. */
  resources: BotCapabilityCatalogResources;
}

function normalizeKey(value: string): string {
  return value.replace(/[-_.\s]/gu, "").toLocaleLowerCase("en-US");
}

function assertPlainRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be plain data.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !("value" in descriptors[key]!) ||
      descriptors[key]!.enumerable !== true
    ) {
      throw new Error(`${label} contains an unsafe or unexpected field.`);
    }
  }
  return value as Record<string, unknown>;
}

function assertPlainArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maximum) {
    throw new Error(`${label} exceeds its safe limit.`);
  }
  const keys = Reflect.ownKeys(Object.getOwnPropertyDescriptors(value));
  if (
    keys.some(
      (key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)),
    )
  ) {
    throw new Error(`${label} has an unsafe array shape.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label} has a sparse or unsafe entry.`);
    }
  }
  return value as unknown[];
}

function scalarLength(value: string): number {
  let result = 0;
  for (const _scalar of value) result += 1;
  return result;
}

function hasUnsafeIdentityCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (
      point <= 0x1f ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function privateIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    scalarLength(value) > BOT_CAPABILITY_PRIVATE_LIMITS.sourceIdChars ||
    !isBoundedBotText(value, BOT_CAPABILITY_PRIVATE_LIMITS.sourceIdChars) ||
    hasUnsafeIdentityCharacter(value)
  ) {
    throw new Error(`${label} has an invalid private identity.`);
  }
  return value;
}

function publicText(
  value: unknown,
  label: string,
  maximum: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.normalize("NFKC").trim();
  if (
    !isBoundedBotText(normalized, maximum, options) ||
    hasUnsafeIdentityCharacter(normalized) ||
    UNSAFE_PUBLIC_TEXT.some((pattern) => pattern.test(normalized))
  ) {
    throw new Error(`${label} cannot be projected safely.`);
  }
  return normalized;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !EXACT_SHA256.test(value)) {
    throw new Error(`${label} must be an exact SHA-256 digest.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Cannot fingerprint non-JSON data.");
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

export function botCapabilityFactsFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function safeOpaqueId(
  mint: BotCapabilityOpaqueIdMint,
  namespace: BotCapabilityOpaqueNamespace,
  sourceIdentity: string,
  exactFingerprint: string,
): string {
  const id = mint(namespace, sourceIdentity, exactFingerprint);
  if (!isPathSafeBotCapabilityId(id)) {
    throw new Error(`The ${namespace} opaque id mint returned an unsafe identity.`);
  }
  return id;
}

function optionFrom(
  id: string,
  label: string,
  available: boolean,
  description?: string,
): BotCapabilityOption {
  return {
    id,
    label: publicText(label, "Bot capability label", BOT_CAPABILITY_LIMITS.labelChars),
    available,
    ...(description === undefined
      ? {}
      : {
          description: publicText(
            description,
            "Bot capability description",
            BOT_CAPABILITY_LIMITS.descriptionChars,
            { allowEmpty: true },
          ),
        }),
  };
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate identities.`);
  }
}

function parseNotice(value: unknown): BotNoticeStatus {
  const record = assertPlainRecord(value, "Bot capability notice", [
    "version",
    "requiresAcknowledgement",
    "acceptedAt",
    "acceptedDecision",
  ]);
  if (
    record.version !== BOT_FULL_ACCESS_NOTICE_VERSION ||
    typeof record.requiresAcknowledgement !== "boolean"
  ) {
    throw new Error("Bot capability notice is invalid.");
  }
  const keys = Object.keys(record);
  if (record.requiresAcknowledgement) {
    if (keys.length !== 2 || "acceptedAt" in record || "acceptedDecision" in record) {
      throw new Error("A pending Bot capability notice cannot contain acceptance data.");
    }
    return {
      version: BOT_FULL_ACCESS_NOTICE_VERSION,
      requiresAcknowledgement: true,
    };
  }
  if (
    keys.length !== 4 ||
    typeof record.acceptedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      record.acceptedAt,
    ) ||
    !Number.isFinite(Date.parse(record.acceptedAt)) ||
    (record.acceptedDecision !== "continue_full" && record.acceptedDecision !== "customize_first")
  ) {
    throw new Error("An acknowledged Bot capability notice is invalid.");
  }
  return {
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    requiresAcknowledgement: false,
    acceptedAt: record.acceptedAt,
    acceptedDecision: record.acceptedDecision,
  };
}

function parseProviders(
  value: unknown,
  mint: BotCapabilityOpaqueIdMint,
): BotCatalogProviderResource[] {
  const input = assertPlainArray(value, "Bot provider inventory", BOT_CAPABILITY_LIMITS.providers);
  let totalModels = 0;
  const resources = input.map((candidate, providerIndex): BotCatalogProviderResource => {
    const provider = assertPlainRecord(candidate, `Bot provider ${providerIndex}`, [
      "sourceId",
      "label",
      "available",
      "connectionFingerprint",
      "models",
    ]);
    if (Object.keys(provider).length !== 5) {
      throw new Error(`Bot provider ${providerIndex} is incomplete.`);
    }
    const sourceId = privateIdentity(provider.sourceId, `Bot provider ${providerIndex}`);
    const connectionFingerprint = fingerprint(
      provider.connectionFingerprint,
      `Bot provider ${providerIndex} connection fingerprint`,
    );
    const exactFingerprint = botCapabilityFactsFingerprint({ connectionFingerprint });
    const id = safeOpaqueId(mint, "provider", sourceId, exactFingerprint);
    const modelsInput = assertPlainArray(
      provider.models,
      `Bot provider ${providerIndex} models`,
      BOT_CAPABILITY_LIMITS.modelsPerProvider,
    );
    if (modelsInput.length === 0) {
      throw new Error(`Bot provider ${providerIndex} must contain at least one model.`);
    }
    totalModels += modelsInput.length;
    if (totalModels > BOT_CAPABILITY_LIMITS.modelsTotal) {
      throw new Error("Bot provider inventory exceeds the aggregate model limit.");
    }
    const models = modelsInput.map((rawModel, modelIndex): BotCatalogModelResource => {
      const model = assertPlainRecord(
        rawModel,
        `Bot provider ${providerIndex} model ${modelIndex}`,
        ["sourceId", "label", "available", "supportsImages", "modelFingerprint"],
      );
      if (![4, 5].includes(Object.keys(model).length)) {
        throw new Error(`Bot provider ${providerIndex} model ${modelIndex} is incomplete.`);
      }
      const sourceModelId = privateIdentity(
        model.sourceId,
        `Bot provider ${providerIndex} model ${modelIndex}`,
      );
      const modelFingerprint = fingerprint(
        model.modelFingerprint,
        `Bot provider ${providerIndex} model ${modelIndex} fingerprint`,
      );
      const modelExactFingerprint = botCapabilityFactsFingerprint({
        connectionFingerprint,
        modelFingerprint,
      });
      return {
        sourceId: sourceModelId,
        modelFingerprint,
        exactFingerprint: modelExactFingerprint,
        option: {
          id: safeOpaqueId(mint, "model", `${sourceId}\0${sourceModelId}`, modelExactFingerprint),
          label: publicText(
            model.label,
            `Bot provider ${providerIndex} model ${modelIndex} label`,
            160,
          ),
          available: booleanValue(
            model.available,
            `Bot provider ${providerIndex} model ${modelIndex} availability`,
          ),
          supportsImages: booleanValue(
            model.supportsImages === true,
            `Bot provider ${providerIndex} model ${modelIndex} image capability`,
          ),
        },
      };
    });
    assertUnique(
      models.map(({ sourceId: modelId }) => modelId),
      `Bot provider ${providerIndex} models`,
    );
    assertUnique(
      models.map(({ option }) => option.id),
      `Bot provider ${providerIndex} opaque models`,
    );
    models.sort((left, right) => compareText(left.option.id, right.option.id));
    return {
      sourceId,
      connectionFingerprint,
      exactFingerprint,
      option: {
        id,
        label: publicText(provider.label, `Bot provider ${providerIndex} label`, 120),
        available: booleanValue(provider.available, `Bot provider ${providerIndex} availability`),
        models: models.map(({ option }) => ({ ...option })),
      },
      models,
    };
  });
  assertUnique(
    resources.map(({ sourceId }) => sourceId),
    "Bot providers",
  );
  assertUnique(
    resources.map(({ option }) => option.id),
    "Bot provider opaque ids",
  );
  return resources.sort((left, right) => compareText(left.option.id, right.option.id));
}

function parseFileScopes(
  value: unknown,
  mint: BotCapabilityOpaqueIdMint,
): BotCatalogFileScopeResource[] {
  const input = assertPlainArray(
    value,
    "Bot file-scope inventory",
    BOT_CAPABILITY_LIMITS.fileScopes,
  );
  const resources = input.map((candidate, index): BotCatalogFileScopeResource => {
    const scope = assertPlainRecord(candidate, `Bot file scope ${index}`, [
      "sourceId",
      "label",
      "description",
      "available",
      "kind",
      "scopeFingerprint",
    ]);
    if (
      !["full_mac", "bot_home", "approved_location"].includes(scope.kind as string) ||
      ![5, 6].includes(Object.keys(scope).length)
    ) {
      throw new Error(`Bot file scope ${index} is invalid.`);
    }
    const sourceId = privateIdentity(scope.sourceId, `Bot file scope ${index}`);
    const scopeFingerprint = fingerprint(
      scope.scopeFingerprint,
      `Bot file scope ${index} fingerprint`,
    );
    const kind = scope.kind as BotFileScopeKind;
    const exactFingerprint = botCapabilityFactsFingerprint({ kind, scopeFingerprint });
    return {
      sourceId,
      scopeFingerprint,
      exactFingerprint,
      option: {
        ...optionFrom(
          safeOpaqueId(mint, "file", sourceId, exactFingerprint),
          scope.label as string,
          booleanValue(scope.available, `Bot file scope ${index} availability`),
          scope.description as string | undefined,
        ),
        kind,
      },
    };
  });
  assertUnique(
    resources.map(({ sourceId }) => sourceId),
    "Bot file scopes",
  );
  assertUnique(
    resources.map(({ option }) => option.id),
    "Bot file-scope opaque ids",
  );
  const fullMac = resources.filter(({ option }) => option.kind === "full_mac");
  const botHome = resources.filter(({ option }) => option.kind === "bot_home");
  if (fullMac.length !== 1 || botHome.length !== 1) {
    throw new Error("Bot file scopes require exactly one Full Mac and one Bot folder choice.");
  }
  const rank: Record<BotFileScopeKind, number> = {
    full_mac: 0,
    bot_home: 1,
    approved_location: 2,
  };
  return resources.sort(
    (left, right) =>
      rank[left.option.kind] - rank[right.option.kind] ||
      compareText(left.option.id, right.option.id),
  );
}

function parseShell(value: unknown): BotCatalogShellResource {
  const shell = assertPlainRecord(value, "Bot shell inventory", ["available", "shellFingerprint"]);
  if (Object.keys(shell).length !== 2) throw new Error("Bot shell inventory is incomplete.");
  const shellFingerprint = fingerprint(shell.shellFingerprint, "Bot shell fingerprint");
  return {
    available: booleanValue(shell.available, "Bot shell availability"),
    shellFingerprint,
    exactFingerprint: botCapabilityFactsFingerprint({ shellFingerprint }),
  };
}

function parseConnections(
  value: unknown,
  mint: BotCapabilityOpaqueIdMint,
): BotCatalogConnectionResource[] {
  const input = assertPlainArray(
    value,
    "Bot connection inventory",
    BOT_CAPABILITY_LIMITS.connections,
  );
  let aggregateTools = 0;
  const resources = input.map((candidate, connectionIndex): BotCatalogConnectionResource => {
    const connection = assertPlainRecord(candidate, `Bot connection ${connectionIndex}`, [
      "sourceId",
      "label",
      "description",
      "available",
      "connectionFingerprint",
      "tools",
    ]);
    if (![5, 6].includes(Object.keys(connection).length)) {
      throw new Error(`Bot connection ${connectionIndex} is incomplete.`);
    }
    const sourceId = privateIdentity(connection.sourceId, `Bot connection ${connectionIndex}`);
    const connectionFingerprint = fingerprint(
      connection.connectionFingerprint,
      `Bot connection ${connectionIndex} fingerprint`,
    );
    const toolsInput = assertPlainArray(
      connection.tools,
      `Bot connection ${connectionIndex} tools`,
      BOT_CAPABILITY_PRIVATE_LIMITS.connectionTools,
    );
    aggregateTools += toolsInput.length;
    if (aggregateTools > BOT_CAPABILITY_PRIVATE_LIMITS.aggregateConnectionTools) {
      throw new Error("Bot connections exceed the aggregate MCP tool limit.");
    }
    const tools = toolsInput.map((candidateTool, toolIndex): BotCatalogMcpToolResource => {
      const tool = assertPlainRecord(
        candidateTool,
        `Bot connection ${connectionIndex} tool ${toolIndex}`,
        [
          "name",
          "inputSchemaFingerprint",
          "outputSchemaFingerprint",
          "effect",
          "effectFingerprint",
        ],
      );
      if (
        Object.keys(tool).length !== 5 ||
        (tool.effect !== "read" && tool.effect !== "mutating")
      ) {
        throw new Error(`Bot connection ${connectionIndex} tool ${toolIndex} is invalid.`);
      }
      const name = privateIdentity(
        tool.name,
        `Bot connection ${connectionIndex} tool ${toolIndex}`,
      );
      if (scalarLength(name) > BOT_CAPABILITY_PRIVATE_LIMITS.toolNameChars) {
        throw new Error(`Bot connection ${connectionIndex} tool ${toolIndex} name is too long.`);
      }
      const normalized = {
        name,
        inputSchemaFingerprint: fingerprint(
          tool.inputSchemaFingerprint,
          `Bot connection ${connectionIndex} tool ${toolIndex} input schema`,
        ),
        outputSchemaFingerprint: fingerprint(
          tool.outputSchemaFingerprint,
          `Bot connection ${connectionIndex} tool ${toolIndex} output schema`,
        ),
        effect: tool.effect,
        effectFingerprint: fingerprint(
          tool.effectFingerprint,
          `Bot connection ${connectionIndex} tool ${toolIndex} effect`,
        ),
      } as const;
      return {
        ...normalized,
        exactFingerprint: botCapabilityFactsFingerprint(normalized),
      };
    });
    assertUnique(
      tools.map(({ name }) => name),
      `Bot connection ${connectionIndex} tools`,
    );
    tools.sort((left, right) => compareText(left.name, right.name));
    const toolsetFingerprint = botCapabilityFactsFingerprint(
      tools.map(({ name, exactFingerprint }) => ({ name, exactFingerprint })),
    );
    const exactFingerprint = botCapabilityFactsFingerprint({
      connectionFingerprint,
      toolsetFingerprint,
    });
    const available = booleanValue(
      connection.available,
      `Bot connection ${connectionIndex} availability`,
    );
    if (available && tools.length === 0) {
      throw new Error(`Bot connection ${connectionIndex} cannot be available without tools.`);
    }
    return {
      sourceId,
      connectionFingerprint,
      toolsetFingerprint,
      exactFingerprint,
      tools,
      option: optionFrom(
        safeOpaqueId(mint, "connection", sourceId, exactFingerprint),
        connection.label as string,
        available,
        connection.description as string | undefined,
      ),
    };
  });
  assertUnique(
    resources.map(({ sourceId }) => sourceId),
    "Bot connections",
  );
  assertUnique(
    resources.map(({ option }) => option.id),
    "Bot connection opaque ids",
  );
  return resources.sort((left, right) => compareText(left.option.id, right.option.id));
}

function parseSkills(value: unknown, mint: BotCapabilityOpaqueIdMint): BotCatalogSkillResource[] {
  const input = assertPlainArray(value, "Bot skill inventory", BOT_CAPABILITY_LIMITS.skills);
  const resources = input.map((candidate, index): BotCatalogSkillResource => {
    const skill = assertPlainRecord(candidate, `Bot skill ${index}`, [
      "sourceId",
      "label",
      "description",
      "available",
      "identityFingerprint",
      "contentFingerprint",
    ]);
    if (![5, 6].includes(Object.keys(skill).length)) {
      throw new Error(`Bot skill ${index} is incomplete.`);
    }
    const sourceId = privateIdentity(skill.sourceId, `Bot skill ${index}`);
    const identityFingerprint = fingerprint(
      skill.identityFingerprint,
      `Bot skill ${index} identity`,
    );
    const contentFingerprint = fingerprint(skill.contentFingerprint, `Bot skill ${index} content`);
    const exactFingerprint = botCapabilityFactsFingerprint({
      identityFingerprint,
      contentFingerprint,
    });
    return {
      sourceId,
      identityFingerprint,
      contentFingerprint,
      exactFingerprint,
      option: optionFrom(
        safeOpaqueId(mint, "skill", sourceId, exactFingerprint),
        skill.label as string,
        booleanValue(skill.available, `Bot skill ${index} availability`),
        skill.description as string | undefined,
      ),
    };
  });
  assertUnique(
    resources.map(({ sourceId }) => sourceId),
    "Bot skills",
  );
  assertUnique(
    resources.map(({ option }) => option.id),
    "Bot skill opaque ids",
  );
  return resources.sort((left, right) => compareText(left.option.id, right.option.id));
}

function parseOtherCapabilities(
  value: unknown,
  mint: BotCapabilityOpaqueIdMint,
): BotCatalogOrdinaryCapabilityResource[] {
  const input = assertPlainArray(
    value,
    "Bot ordinary capability inventory",
    BOT_CAPABILITY_LIMITS.otherCapabilities,
  );
  const resources = input.map((candidate, index): BotCatalogOrdinaryCapabilityResource => {
    const capability = assertPlainRecord(candidate, `Bot ordinary capability ${index}`, [
      "kind",
      "label",
      "description",
      "available",
      "capabilityFingerprint",
    ]);
    if (
      ![4, 5].includes(Object.keys(capability).length) ||
      !BOT_ORDINARY_CAPABILITY_KINDS.includes(capability.kind as BotOrdinaryCapabilityKind)
    ) {
      throw new Error(`Bot ordinary capability ${index} is invalid.`);
    }
    const kind = capability.kind as BotOrdinaryCapabilityKind;
    const capabilityFingerprint = fingerprint(
      capability.capabilityFingerprint,
      `Bot ordinary capability ${index} fingerprint`,
    );
    const exactFingerprint = botCapabilityFactsFingerprint({
      kind,
      capabilityFingerprint,
    });
    return {
      kind,
      capabilityFingerprint,
      exactFingerprint,
      option: optionFrom(
        safeOpaqueId(mint, "other", kind, exactFingerprint),
        capability.label as string,
        booleanValue(capability.available, `Bot ordinary capability ${index} availability`),
        capability.description as string | undefined,
      ),
    };
  });
  assertUnique(
    resources.map(({ kind }) => kind),
    "Bot ordinary capabilities",
  );
  assertUnique(
    resources.map(({ option }) => option.id),
    "Bot ordinary capability opaque ids",
  );
  return resources.sort((left, right) => compareText(left.option.id, right.option.id));
}

function catalogRevisionInput(value: Omit<BotCapabilityCatalog, "revision" | "notice">): unknown {
  return value;
}

export function botCapabilityCatalogRevision(
  value: Omit<BotCapabilityCatalog, "revision" | "notice">,
): string {
  return `bot_catalog_${botCapabilityFactsFingerprint(catalogRevisionInput(value))}`;
}

export function finalizeBotCapabilityCatalog(input: {
  providers: BotProviderOption[];
  fileScopes: BotFileScopeOption[];
  shellAvailable: boolean;
  connections: BotCapabilityOption[];
  skills: BotCapabilityOption[];
  otherCapabilities: BotCapabilityOption[];
  notice: BotNoticeStatus;
}): BotCapabilityCatalog {
  const capabilities = {
    providers: input.providers,
    fileScopes: input.fileScopes,
    shellAvailable: input.shellAvailable,
    connections: input.connections,
    skills: input.skills,
    otherCapabilities: input.otherCapabilities,
  };
  const catalog: BotCapabilityCatalog = {
    revision: botCapabilityCatalogRevision(capabilities),
    ...capabilities,
    notice: parseNotice(input.notice),
  };
  assertSafeBotCapabilityCatalogProjection(catalog);
  if (
    Buffer.byteLength(JSON.stringify(catalog), "utf8") > BOT_CAPABILITY_CATALOG_MAX_PUBLIC_BYTES
  ) {
    throw new Error("Bot capability catalog exceeds the safe public byte limit.");
  }
  return catalog;
}

/**
 * Build one deterministic public catalog plus the exact main-only facts used to
 * bind Custom grants. No inventory object is trusted merely because it came
 * from another main-process service.
 */
export function buildBotCapabilityCatalogSnapshot(input: {
  inventory: BotCapabilityInventory;
  notice: BotNoticeStatus;
  mintOpaqueId: BotCapabilityOpaqueIdMint;
}): BotCapabilityCatalogSnapshot {
  const inventory = assertPlainRecord(input.inventory, "Bot capability inventory", [
    "providers",
    "fileScopes",
    "shell",
    "connections",
    "skills",
    "otherCapabilities",
  ]);
  if (Object.keys(inventory).length !== 6 || typeof input.mintOpaqueId !== "function") {
    throw new Error("Bot capability inventory is incomplete.");
  }
  const resources: BotCapabilityCatalogResources = {
    providers: parseProviders(inventory.providers, input.mintOpaqueId),
    fileScopes: parseFileScopes(inventory.fileScopes, input.mintOpaqueId),
    shell: parseShell(inventory.shell),
    connections: parseConnections(inventory.connections, input.mintOpaqueId),
    skills: parseSkills(inventory.skills, input.mintOpaqueId),
    otherCapabilities: parseOtherCapabilities(inventory.otherCapabilities, input.mintOpaqueId),
  };
  const catalog = finalizeBotCapabilityCatalog({
    providers: resources.providers.map(({ option }) => structuredClone(option)),
    fileScopes: resources.fileScopes.map(({ option }) => ({ ...option })),
    shellAvailable: resources.shell.available,
    connections: resources.connections.map(({ option }) => ({ ...option })),
    skills: resources.skills.map(({ option }) => ({ ...option })),
    otherCapabilities: resources.otherCapabilities.map(({ option }) => ({ ...option })),
    notice: input.notice,
  });
  return { catalog, resources };
}

/** Recursive last-line guard before a projection reaches IPC or HTTP. */
export function assertSafeBotCapabilityCatalogProjection(
  value: unknown,
): asserts value is BotCapabilityCatalog {
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (PRIVATE_PUBLIC_KEYS.has(normalizeKey(key))) {
        throw new Error("Bot capability catalog contains private main-process data.");
      }
      visit(child);
    }
  };
  visit(value);
  const catalog = assertPlainRecord(value, "Bot capability catalog", [
    "revision",
    "providers",
    "fileScopes",
    "shellAvailable",
    "connections",
    "skills",
    "otherCapabilities",
    "notice",
  ]);
  if (
    Object.keys(catalog).length !== 8 ||
    !isPathSafeBotCapabilityId(catalog.revision) ||
    typeof catalog.shellAvailable !== "boolean"
  ) {
    throw new Error("Bot capability catalog projection is invalid.");
  }
  const option = (candidate: unknown, label: string): { id: string; available: boolean } => {
    const projected = assertPlainRecord(candidate, label, [
      "id",
      "label",
      "available",
      "description",
    ]);
    if (
      ![3, 4].includes(Object.keys(projected).length) ||
      !isPathSafeBotCapabilityId(projected.id) ||
      publicText(projected.label, `${label} label`, BOT_CAPABILITY_LIMITS.labelChars) !==
        projected.label ||
      typeof projected.available !== "boolean" ||
      (projected.description !== undefined &&
        publicText(
          projected.description,
          `${label} description`,
          BOT_CAPABILITY_LIMITS.descriptionChars,
          { allowEmpty: true },
        ) !== projected.description)
    ) {
      throw new Error(`${label} is not a safe public option.`);
    }
    return { id: projected.id, available: projected.available };
  };
  const providers = assertPlainArray(
    catalog.providers,
    "Bot capability providers",
    BOT_CAPABILITY_LIMITS.providers,
  );
  let modelCount = 0;
  const providerIds = providers.map((candidate, providerIndex) => {
    const provider = assertPlainRecord(candidate, `Bot capability provider ${providerIndex}`, [
      "id",
      "label",
      "available",
      "models",
    ]);
    const providerIdentity = option(
      {
        id: provider.id,
        label: provider.label,
        available: provider.available,
      },
      `Bot capability provider ${providerIndex}`,
    );
    const models = assertPlainArray(
      provider.models,
      `Bot capability provider ${providerIndex} models`,
      BOT_CAPABILITY_LIMITS.modelsPerProvider,
    );
    modelCount += models.length;
    const modelIds = models.map((model, modelIndex) => {
      const projected = assertPlainRecord(
        model,
        `Bot capability provider ${providerIndex} model ${modelIndex}`,
        ["id", "label", "available", "supportsImages"],
      );
      if (
        Object.keys(projected).length !== 4 ||
        !isPathSafeBotCapabilityId(projected.id) ||
        publicText(
          projected.label,
          `Bot capability provider ${providerIndex} model ${modelIndex} label`,
          160,
        ) !== projected.label ||
        typeof projected.available !== "boolean" ||
        typeof projected.supportsImages !== "boolean"
      ) {
        throw new Error(`Bot capability provider ${providerIndex} model ${modelIndex} is unsafe.`);
      }
      return projected.id;
    });
    assertUnique(modelIds, `Bot capability provider ${providerIndex} models`);
    return providerIdentity.id;
  });
  if (modelCount > BOT_CAPABILITY_LIMITS.modelsTotal) {
    throw new Error("Bot capability catalog exceeds the aggregate model limit.");
  }
  assertUnique(providerIds, "Bot capability providers");
  const fileScopes = assertPlainArray(
    catalog.fileScopes,
    "Bot capability file scopes",
    BOT_CAPABILITY_LIMITS.fileScopes,
  );
  const fileIds = fileScopes.map((candidate, index) => {
    const projected = assertPlainRecord(candidate, `Bot capability file scope ${index}`, [
      "id",
      "label",
      "available",
      "description",
      "kind",
    ]);
    const identity = option(
      Object.fromEntries(Object.entries(projected).filter(([key]) => key !== "kind")),
      `Bot capability file scope ${index}`,
    );
    if (
      projected.kind !== "full_mac" &&
      projected.kind !== "bot_home" &&
      projected.kind !== "approved_location"
    ) {
      throw new Error(`Bot capability file scope ${index} has an unsafe kind.`);
    }
    return identity.id;
  });
  assertUnique(fileIds, "Bot capability file scopes");
  const optionArray = (candidate: unknown, label: string, maximum: number): void => {
    const values = assertPlainArray(candidate, label, maximum);
    const ids = values.map((entry, index) => option(entry, `${label} ${index}`).id);
    assertUnique(ids, label);
  };
  optionArray(catalog.connections, "Bot capability connections", BOT_CAPABILITY_LIMITS.connections);
  optionArray(catalog.skills, "Bot capability skills", BOT_CAPABILITY_LIMITS.skills);
  optionArray(
    catalog.otherCapabilities,
    "Bot capability ordinary capabilities",
    BOT_CAPABILITY_LIMITS.otherCapabilities,
  );
  parseNotice(catalog.notice);
  const expectedRevision = botCapabilityCatalogRevision({
    providers: catalog.providers as BotProviderOption[],
    fileScopes: catalog.fileScopes as BotFileScopeOption[],
    shellAvailable: catalog.shellAvailable,
    connections: catalog.connections as BotCapabilityOption[],
    skills: catalog.skills as BotCapabilityOption[],
    otherCapabilities: catalog.otherCapabilities as BotCapabilityOption[],
  });
  if (catalog.revision !== expectedRevision) {
    throw new Error("Bot capability catalog revision does not match its safe public data.");
  }
}
