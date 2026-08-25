import { createHmac } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  BOT_CAPABILITY_LIMITS,
  BOT_FILE_SCOPE_SELECTION_GUIDANCE,
  BotCapabilityValidationError,
  botFileScopeSelectionIsCoherent,
  cloneBotCustomSelection,
  isBoundedBotText,
  isPathSafeBotCapabilityId,
  parseBotCustomSelection,
  validateSelectionAgainstCatalog,
  type BotCapabilityOption,
  type BotCustomSelection,
  type BotFileScopeOption,
  type BotModelOption,
  type BotProviderOption,
} from "../../renderer/shared/bot-capabilities.js";
import {
  BOT_CAPABILITY_PRIVATE_LIMITS,
  BOT_ORDINARY_CAPABILITY_KINDS,
  botCapabilityFactsFingerprint,
  finalizeBotCapabilityCatalog,
  type BotCapabilityCatalogSnapshot,
  type BotCapabilityOpaqueIdMint,
  type BotCapabilityOpaqueNamespace,
  type BotCatalogConnectionResource,
  type BotCatalogFileScopeResource,
  type BotCatalogMcpToolResource,
  type BotCatalogModelResource,
  type BotCatalogOrdinaryCapabilityResource,
  type BotCatalogProviderResource,
  type BotCatalogSkillResource,
} from "./bot-capability-catalog-core.js";

export const BOT_CAPABILITY_OPAQUE_KEY_BYTES = 32;
export const BOT_CAPABILITY_BINDING_VERSION = 1 as const;

const EXACT_SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_ID_DOMAIN_V1 = "aiden-bot-capability-v1";
const OPAQUE_ID_DOMAIN_V2 = "aiden-bot-capability-v2";
const mintKeys = new WeakMap<BotCapabilityOpaqueIdMint, Buffer>();

export interface BoundBotProviderModel {
  providerOption: Omit<BotProviderOption, "models">;
  modelOption: BotModelOption;
  sourceProviderId: string;
  sourceModelId: string;
  connectionFingerprint: string;
  providerExactFingerprint: string;
  modelFingerprint: string;
  modelExactFingerprint: string;
}

export interface BoundBotFileScope {
  option: BotFileScopeOption;
  sourceId: string;
  scopeFingerprint: string;
  exactFingerprint: string;
}

export interface BoundBotShell {
  shellFingerprint: string;
  exactFingerprint: string;
}

export interface BoundBotConnection {
  option: BotCapabilityOption;
  sourceId: string;
  connectionFingerprint: string;
  toolsetFingerprint: string;
  exactFingerprint: string;
  tools: BotCatalogMcpToolResource[];
}

export interface BoundBotSkill {
  option: BotCapabilityOption;
  sourceId: string;
  identityFingerprint: string;
  contentFingerprint: string;
  exactFingerprint: string;
}

export interface BoundBotOrdinaryCapability {
  option: BotCapabilityOption;
  kind: BotCatalogOrdinaryCapabilityResource["kind"];
  capabilityFingerprint: string;
  exactFingerprint: string;
}

/**
 * Main-only exact grants corresponding to one renderer-safe Custom selection.
 * None of these fields are accepted from renderer or Remote API input.
 */
export interface BoundBotCustomSelection {
  version: typeof BOT_CAPABILITY_BINDING_VERSION;
  catalogRevision: string;
  selection: BotCustomSelection;
  provider: BoundBotProviderModel;
  fileScopes: BoundBotFileScope[];
  shell?: BoundBotShell;
  connections: BoundBotConnection[];
  skills: BoundBotSkill[];
  otherCapabilities: BoundBotOrdinaryCapability[];
}

export type BotCapabilityDriftGroup =
  | "provider"
  | "model"
  | "file_scope"
  | "shell"
  | "connection"
  | "skill"
  | "other_capability";

export interface BotCapabilityDriftIssue {
  group: BotCapabilityDriftGroup;
  /** Opaque public selection id. Shell has no public id. */
  selectionId?: string;
  reason: "unavailable" | "changed_or_removed";
}

export interface ReconciledBotCustomSelection {
  state: "ready" | "drifted";
  selection: BotCustomSelection;
  issues: BotCapabilityDriftIssue[];
  catalogSnapshot: BotCapabilityCatalogSnapshot;
}

export class BotCapabilityBindingDriftError extends Error {
  constructor(readonly issues: readonly BotCapabilityDriftIssue[]) {
    super("Some selected Bot access changed or is unavailable. Review it before this Bot acts.");
    this.name = "BotCapabilityBindingDriftError";
  }
}

function copyBytes(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== BOT_CAPABILITY_OPAQUE_KEY_BYTES) {
    throw new Error("Bot capability opaque ids require a persisted 32-byte key.");
  }
  return Buffer.from(value);
}

function mintOpaqueIdWithDomain(
  key: Buffer,
  domain: typeof OPAQUE_ID_DOMAIN_V1 | typeof OPAQUE_ID_DOMAIN_V2,
  namespace: BotCapabilityOpaqueNamespace,
  sourceIdentity: string,
  exactFingerprint: string,
): string {
  if (!EXACT_SHA256.test(exactFingerprint) || !sourceIdentity) {
    throw new Error("Cannot mint a Bot capability id from invalid exact facts.");
  }
  const hmac = createHmac("sha256", key)
    .update(domain)
    .update("\0")
    .update(namespace)
    .update("\0")
    .update(sourceIdentity);
  // v1 mixed live fingerprints into the public id, so MCP/skill churn rotated
  // checkboxes mid-wizard. v2 is identity-stable; exact facts stay in bindings.
  if (domain === OPAQUE_ID_DOMAIN_V1) {
    hmac.update("\0").update(exactFingerprint);
  }
  const id = `bc_${namespace}_${hmac.digest("base64url")}`;
  if (!isPathSafeBotCapabilityId(id)) {
    throw new Error("Minted Bot capability id exceeded the public identity contract.");
  }
  return id;
}

/**
 * Create stable, unlinkable selection ids. Callers must load the same private
 * key after every restart; this helper deliberately never generates one.
 * Public ids follow source identity, not live fingerprints, so a wizard can
 * keep the same checkboxes while Custom still fail-closes on stored facts.
 */
export function createBotCapabilityOpaqueIdMint(
  persistedKey: Uint8Array,
): BotCapabilityOpaqueIdMint {
  const key = copyBytes(persistedKey);
  const mint: BotCapabilityOpaqueIdMint = (
    namespace: BotCapabilityOpaqueNamespace,
    sourceIdentity: string,
    exactFingerprint: string,
  ): string =>
    mintOpaqueIdWithDomain(key, OPAQUE_ID_DOMAIN_V2, namespace, sourceIdentity, exactFingerprint);
  mintKeys.set(mint, key);
  return mint;
}

export function mintLegacyBotCapabilityOpaqueId(
  persistedKey: Uint8Array,
  namespace: BotCapabilityOpaqueNamespace,
  sourceIdentity: string,
  exactFingerprint: string,
): string {
  return mintOpaqueIdWithDomain(
    copyBytes(persistedKey),
    OPAQUE_ID_DOMAIN_V1,
    namespace,
    sourceIdentity,
    exactFingerprint,
  );
}

function opaqueIdMatchesMint(
  mintOpaqueId: BotCapabilityOpaqueIdMint,
  namespace: BotCapabilityOpaqueNamespace,
  sourceIdentity: string,
  exactFingerprint: string,
  actualId: string,
): boolean {
  if (actualId === mintOpaqueId(namespace, sourceIdentity, exactFingerprint)) return true;
  const key = mintKeys.get(mintOpaqueId);
  return (
    key !== undefined &&
    actualId ===
      mintOpaqueIdWithDomain(key, OPAQUE_ID_DOMAIN_V1, namespace, sourceIdentity, exactFingerprint)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function storedRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be plain private data.`);
  }
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
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
  if (!required.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label} is incomplete.`);
  }
  return value as Record<string, unknown>;
}

function storedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maximum) {
    throw new Error(`${label} exceeds its private storage limit.`);
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

function storedFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !EXACT_SHA256.test(value)) {
    throw new Error(`${label} must be an exact SHA-256 digest.`);
  }
  return value;
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

function storedSourceIdentity(value: unknown, label: string): string {
  if (
    !isBoundedBotText(value, BOT_CAPABILITY_PRIVATE_LIMITS.sourceIdChars) ||
    hasUnsafeIdentityCharacter(value) ||
    /^(?:~\/|\/|[A-Za-z]:[\\/]|file:\/\/)/iu.test(value)
  ) {
    throw new Error(`${label} has an invalid private identity.`);
  }
  return value;
}

function storedOption(
  value: unknown,
  label: string,
  options: { description?: boolean } = {},
): BotCapabilityOption {
  const option = storedRecord(
    value,
    label,
    ["id", "label", "available"],
    options.description ? ["description"] : [],
  );
  const hasDescription = Object.prototype.hasOwnProperty.call(option, "description");
  if (
    !isPathSafeBotCapabilityId(option.id) ||
    !isBoundedBotText(option.label, BOT_CAPABILITY_LIMITS.labelChars) ||
    option.available !== true ||
    (hasDescription &&
      !isBoundedBotText(option.description, BOT_CAPABILITY_LIMITS.descriptionChars, {
        allowEmpty: true,
      }))
  ) {
    throw new Error(`${label} is not a valid selected public option.`);
  }
  return {
    id: option.id,
    label: option.label,
    available: true,
    ...(hasDescription ? { description: option.description as string } : {}),
  };
}

function storedSelectionIds(value: unknown, maximum: number, label: string): string[] {
  const ids = storedArray(value, label, maximum).map((candidate) => {
    if (!isPathSafeBotCapabilityId(candidate)) {
      throw new Error(`${label} contains an invalid opaque id.`);
    }
    return candidate;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate opaque ids.`);
  }
  return ids;
}

function parseStoredSelection(value: unknown): BotCustomSelection {
  const selection = storedRecord(value, "Bot Custom private selection", [
    "providerId",
    "modelId",
    "fileScopeIds",
    "shellEnabled",
    "connectionIds",
    "skillIds",
    "otherCapabilityIds",
  ]);
  if (
    !isPathSafeBotCapabilityId(selection.providerId) ||
    !isPathSafeBotCapabilityId(selection.modelId) ||
    typeof selection.shellEnabled !== "boolean"
  ) {
    throw new Error("Bot Custom private selection is invalid.");
  }
  return parseBotCustomSelection({
    providerId: selection.providerId,
    modelId: selection.modelId,
    fileScopeIds: storedSelectionIds(
      selection.fileScopeIds,
      BOT_CAPABILITY_LIMITS.fileScopes,
      "Bot Custom private file scopes",
    ),
    shellEnabled: selection.shellEnabled,
    connectionIds: storedSelectionIds(
      selection.connectionIds,
      BOT_CAPABILITY_LIMITS.connections,
      "Bot Custom private connections",
    ),
    skillIds: storedSelectionIds(
      selection.skillIds,
      BOT_CAPABILITY_LIMITS.skills,
      "Bot Custom private skills",
    ),
    otherCapabilityIds: storedSelectionIds(
      selection.otherCapabilityIds,
      BOT_CAPABILITY_LIMITS.otherCapabilities,
      "Bot Custom private ordinary capabilities",
    ),
  });
}

function storedProviderOption(value: unknown): Omit<BotProviderOption, "models"> {
  const option = storedOption(value, "Bot bound provider");
  return option;
}

function storedModelOption(value: unknown): BotModelOption {
  const model = storedRecord(value, "Bot bound model", [
    "id",
    "label",
    "available",
  ], ["supportsImages"]);
  if (
    !isPathSafeBotCapabilityId(model.id) ||
    !isBoundedBotText(model.label, 160) ||
    model.available !== true ||
    (model.supportsImages !== undefined && typeof model.supportsImages !== "boolean")
  ) {
    throw new Error("Bot bound model is not a valid selected public option.");
  }
  return {
    id: model.id,
    label: model.label,
    available: true,
    ...(model.supportsImages === undefined
      ? {}
      : { supportsImages: model.supportsImages }),
  };
}

function exactFacts(stored: string, calculated: unknown, label: string): string {
  const expected = botCapabilityFactsFingerprint(calculated);
  if (stored !== expected) {
    throw new Error(`${label} does not match its exact private facts.`);
  }
  return stored;
}

function parseBoundProvider(value: unknown): BoundBotProviderModel {
  const provider = storedRecord(value, "Bot bound provider/model", [
    "providerOption",
    "modelOption",
    "sourceProviderId",
    "sourceModelId",
    "connectionFingerprint",
    "providerExactFingerprint",
    "modelFingerprint",
    "modelExactFingerprint",
  ]);
  const providerOption = storedProviderOption(provider.providerOption);
  const modelOption = storedModelOption(provider.modelOption);
  const sourceProviderId = storedSourceIdentity(provider.sourceProviderId, "Bot bound provider");
  const sourceModelId = storedSourceIdentity(provider.sourceModelId, "Bot bound model");
  const connectionFingerprint = storedFingerprint(
    provider.connectionFingerprint,
    "Bot bound provider connection",
  );
  const providerExactFingerprint = exactFacts(
    storedFingerprint(provider.providerExactFingerprint, "Bot bound provider exact fingerprint"),
    { connectionFingerprint },
    "Bot bound provider fingerprint",
  );
  const modelFingerprint = storedFingerprint(
    provider.modelFingerprint,
    "Bot bound model fingerprint",
  );
  const modelExactFingerprint = exactFacts(
    storedFingerprint(provider.modelExactFingerprint, "Bot bound model exact fingerprint"),
    { connectionFingerprint, modelFingerprint },
    "Bot bound model fingerprint",
  );
  return {
    providerOption,
    modelOption,
    sourceProviderId,
    sourceModelId,
    connectionFingerprint,
    providerExactFingerprint,
    modelFingerprint,
    modelExactFingerprint,
  };
}

/** Strict decoder for the provider/model slice retained by a Full Bot policy. */
export function parseBoundBotProviderModel(value: unknown): BoundBotProviderModel {
  return parseBoundProvider(value);
}

export function cloneBoundBotProviderModel(
  value: BoundBotProviderModel,
): BoundBotProviderModel {
  return parseBoundProvider(value);
}

export function boundBotProviderModelFingerprint(value: BoundBotProviderModel): string {
  const provider = parseBoundProvider(value);
  return botCapabilityFactsFingerprint({
    providerId: provider.providerOption.id,
    providerExactFingerprint: provider.providerExactFingerprint,
    modelId: provider.modelOption.id,
    modelExactFingerprint: provider.modelExactFingerprint,
  });
}

/** Return only public opaque drift facts for a Bot-owned provider/model binding. */
export function botProviderModelDrift(
  binding: BoundBotProviderModel,
  current: BotCapabilityCatalogSnapshot,
): BotCapabilityDriftIssue[] {
  binding = parseBoundBotProviderModel(binding);
  const issues: BotCapabilityDriftIssue[] = [];
  const provider = current.resources.providers.find(
    ({ option }) => option.id === binding.providerOption.id,
  );
  if (
    !provider ||
    provider.sourceId !== binding.sourceProviderId ||
    provider.exactFingerprint !== binding.providerExactFingerprint
  ) {
    issues.push(issue("provider", binding.providerOption.id, "changed_or_removed"));
  } else if (!provider.option.available) {
    issues.push(issue("provider", binding.providerOption.id, "unavailable"));
  }
  const model = provider?.models.find(({ option }) => option.id === binding.modelOption.id);
  if (
    !model ||
    model.sourceId !== binding.sourceModelId ||
    model.exactFingerprint !== binding.modelExactFingerprint ||
    (binding.modelOption.supportsImages !== undefined &&
      model.option.supportsImages !== binding.modelOption.supportsImages)
  ) {
    issues.push(issue("model", binding.modelOption.id, "changed_or_removed"));
  } else if (!model.option.available) {
    issues.push(issue("model", binding.modelOption.id, "unavailable"));
  }
  return issues;
}

export function assertBoundBotProviderModelCurrent(
  binding: BoundBotProviderModel,
  current: BotCapabilityCatalogSnapshot,
): void {
  const issues = botProviderModelDrift(binding, current);
  if (issues.length > 0) throw new BotCapabilityBindingDriftError(issues);
}

function parseBoundFileScope(value: unknown, index: number): BoundBotFileScope {
  const scope = storedRecord(value, `Bot bound file scope ${index}`, [
    "option",
    "sourceId",
    "scopeFingerprint",
    "exactFingerprint",
  ]);
  const rawOption = storedRecord(
    scope.option,
    `Bot bound file scope ${index} option`,
    ["id", "label", "available", "kind"],
    ["description"],
  );
  const baseOption = storedOption(
    Object.fromEntries(Object.entries(rawOption).filter(([key]) => key !== "kind")),
    `Bot bound file scope ${index} option`,
    { description: true },
  );
  if (
    rawOption.kind !== "full_mac" &&
    rawOption.kind !== "bot_home" &&
    rawOption.kind !== "approved_location"
  ) {
    throw new Error(`Bot bound file scope ${index} has an invalid kind.`);
  }
  const sourceId = storedSourceIdentity(scope.sourceId, `Bot bound file scope ${index}`);
  const scopeFingerprint = storedFingerprint(
    scope.scopeFingerprint,
    `Bot bound file scope ${index} fingerprint`,
  );
  const exactFingerprint = exactFacts(
    storedFingerprint(scope.exactFingerprint, `Bot bound file scope ${index} exact fingerprint`),
    { kind: rawOption.kind, scopeFingerprint },
    `Bot bound file scope ${index} fingerprint`,
  );
  return {
    option: { ...baseOption, kind: rawOption.kind },
    sourceId,
    scopeFingerprint,
    exactFingerprint,
  };
}

function parseBoundShell(value: unknown): BoundBotShell {
  const shell = storedRecord(value, "Bot bound shell", ["shellFingerprint", "exactFingerprint"]);
  const shellFingerprint = storedFingerprint(shell.shellFingerprint, "Bot bound shell fingerprint");
  return {
    shellFingerprint,
    exactFingerprint: exactFacts(
      storedFingerprint(shell.exactFingerprint, "Bot bound shell exact fingerprint"),
      { shellFingerprint },
      "Bot bound shell fingerprint",
    ),
  };
}

function parseBoundTool(
  value: unknown,
  connectionIndex: number,
  toolIndex: number,
): BotCatalogMcpToolResource {
  const label = `Bot bound connection ${connectionIndex} tool ${toolIndex}`;
  const tool = storedRecord(value, label, [
    "name",
    "inputSchemaFingerprint",
    "outputSchemaFingerprint",
    "effect",
    "effectFingerprint",
    "exactFingerprint",
  ]);
  const name = storedSourceIdentity(tool.name, label);
  if (
    !isBoundedBotText(name, BOT_CAPABILITY_PRIVATE_LIMITS.toolNameChars) ||
    (tool.effect !== "read" && tool.effect !== "mutating")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  const inputSchemaFingerprint = storedFingerprint(
    tool.inputSchemaFingerprint,
    `${label} input schema`,
  );
  const outputSchemaFingerprint = storedFingerprint(
    tool.outputSchemaFingerprint,
    `${label} output schema`,
  );
  const effectFingerprint = storedFingerprint(tool.effectFingerprint, `${label} effect`);
  const facts = {
    name,
    inputSchemaFingerprint,
    outputSchemaFingerprint,
    effect: tool.effect,
    effectFingerprint,
  } as const;
  return {
    ...facts,
    exactFingerprint: exactFacts(
      storedFingerprint(tool.exactFingerprint, `${label} exact fingerprint`),
      facts,
      `${label} fingerprint`,
    ),
  };
}

function parseBoundConnection(value: unknown, index: number): BoundBotConnection {
  const label = `Bot bound connection ${index}`;
  const connection = storedRecord(value, label, [
    "option",
    "sourceId",
    "connectionFingerprint",
    "toolsetFingerprint",
    "exactFingerprint",
    "tools",
  ]);
  const option = storedOption(connection.option, `${label} option`, { description: true });
  const sourceId = storedSourceIdentity(connection.sourceId, label);
  const connectionFingerprint = storedFingerprint(
    connection.connectionFingerprint,
    `${label} connection fingerprint`,
  );
  const tools = storedArray(
    connection.tools,
    `${label} tools`,
    BOT_CAPABILITY_PRIVATE_LIMITS.connectionTools,
  )
    .map((tool, toolIndex) => parseBoundTool(tool, index, toolIndex))
    .sort((left, right) => compareText(left.name, right.name));
  if (new Set(tools.map(({ name }) => name)).size !== tools.length || tools.length === 0) {
    throw new Error(`${label} has duplicate or missing tools.`);
  }
  const toolsetFingerprint = exactFacts(
    storedFingerprint(connection.toolsetFingerprint, `${label} toolset fingerprint`),
    tools.map(({ name, exactFingerprint }) => ({ name, exactFingerprint })),
    `${label} toolset fingerprint`,
  );
  const exactFingerprint = exactFacts(
    storedFingerprint(connection.exactFingerprint, `${label} exact fingerprint`),
    { connectionFingerprint, toolsetFingerprint },
    `${label} fingerprint`,
  );
  return {
    option,
    sourceId,
    connectionFingerprint,
    toolsetFingerprint,
    exactFingerprint,
    tools,
  };
}

function parseBoundSkill(value: unknown, index: number): BoundBotSkill {
  const label = `Bot bound skill ${index}`;
  const skill = storedRecord(value, label, [
    "option",
    "sourceId",
    "identityFingerprint",
    "contentFingerprint",
    "exactFingerprint",
  ]);
  const option = storedOption(skill.option, `${label} option`, { description: true });
  const sourceId = storedSourceIdentity(skill.sourceId, label);
  const identityFingerprint = storedFingerprint(
    skill.identityFingerprint,
    `${label} identity fingerprint`,
  );
  const contentFingerprint = storedFingerprint(
    skill.contentFingerprint,
    `${label} content fingerprint`,
  );
  return {
    option,
    sourceId,
    identityFingerprint,
    contentFingerprint,
    exactFingerprint: exactFacts(
      storedFingerprint(skill.exactFingerprint, `${label} exact fingerprint`),
      { identityFingerprint, contentFingerprint },
      `${label} fingerprint`,
    ),
  };
}

function parseBoundOther(value: unknown, index: number): BoundBotOrdinaryCapability {
  const label = `Bot bound ordinary capability ${index}`;
  const capability = storedRecord(value, label, [
    "option",
    "kind",
    "capabilityFingerprint",
    "exactFingerprint",
  ]);
  if (
    !BOT_ORDINARY_CAPABILITY_KINDS.includes(
      capability.kind as (typeof BOT_ORDINARY_CAPABILITY_KINDS)[number],
    )
  ) {
    throw new Error(`${label} has an invalid kind.`);
  }
  const kind = capability.kind as BoundBotOrdinaryCapability["kind"];
  const option = storedOption(capability.option, `${label} option`, { description: true });
  const capabilityFingerprint = storedFingerprint(
    capability.capabilityFingerprint,
    `${label} fingerprint`,
  );
  return {
    option,
    kind,
    capabilityFingerprint,
    exactFingerprint: exactFacts(
      storedFingerprint(capability.exactFingerprint, `${label} exact fingerprint`),
      { kind, capabilityFingerprint },
      `${label} fingerprint`,
    ),
  };
}

function selectionMatchesBinding(binding: BoundBotCustomSelection): void {
  const idsMatch = (selected: readonly string[], bound: readonly { option: { id: string } }[]) => {
    const left = [...selected].sort(compareText);
    const right = bound.map(({ option }) => option.id).sort(compareText);
    return left.length === right.length && left.every((value, index) => value === right[index]);
  };
  if (
    binding.selection.providerId !== binding.provider.providerOption.id ||
    binding.selection.modelId !== binding.provider.modelOption.id ||
    binding.selection.shellEnabled !== Boolean(binding.shell) ||
    !idsMatch(binding.selection.fileScopeIds, binding.fileScopes) ||
    !idsMatch(binding.selection.connectionIds, binding.connections) ||
    !idsMatch(binding.selection.skillIds, binding.skills) ||
    !idsMatch(binding.selection.otherCapabilityIds, binding.otherCapabilities)
  ) {
    throw new Error("Bot Custom binding does not match its public selection.");
  }
  const kinds = binding.fileScopes.map(({ option }) => option.kind);
  const fullMac = kinds.filter((kind) => kind === "full_mac").length;
  const botHome = kinds.filter((kind) => kind === "bot_home").length;
  const approved = kinds.filter((kind) => kind === "approved_location").length;
  if (
    fullMac > 1 ||
    botHome > 1 ||
    (fullMac === 1 && kinds.length !== 1) ||
    (approved > 0 && botHome !== 1)
  ) {
    throw new Error("Bot Custom binding contains an incoherent Files selection.");
  }
}

/**
 * Strict fail-closed decoder for the main-only 0600 policy companion fields.
 * It accepts no paths, accessors, extra keys, stale derived digests, or public
 * selection/binding mismatches and returns a detached canonical clone.
 */
export function parseBoundBotCustomSelection(value: unknown): BoundBotCustomSelection {
  const binding = storedRecord(
    value,
    "Bot Custom private binding",
    [
      "version",
      "catalogRevision",
      "selection",
      "provider",
      "fileScopes",
      "connections",
      "skills",
      "otherCapabilities",
    ],
    ["shell"],
  );
  if (
    binding.version !== BOT_CAPABILITY_BINDING_VERSION ||
    !isPathSafeBotCapabilityId(binding.catalogRevision, BOT_CAPABILITY_LIMITS.catalogRevisionChars)
  ) {
    throw new Error("Bot Custom binding has an invalid version or revision.");
  }
  const selection = parseStoredSelection(binding.selection);
  const provider = parseBoundProvider(binding.provider);
  const fileScopes = storedArray(
    binding.fileScopes,
    "Bot bound file scopes",
    BOT_CAPABILITY_LIMITS.fileScopes,
  )
    .map(parseBoundFileScope)
    .sort((left, right) => compareText(left.option.id, right.option.id));
  const connections = storedArray(
    binding.connections,
    "Bot bound connections",
    BOT_CAPABILITY_LIMITS.connections,
  )
    .map(parseBoundConnection)
    .sort((left, right) => compareText(left.option.id, right.option.id));
  const aggregateTools = connections.reduce(
    (total, connection) => total + connection.tools.length,
    0,
  );
  if (aggregateTools > BOT_CAPABILITY_PRIVATE_LIMITS.aggregateConnectionTools) {
    throw new Error("Bot bound connections exceed the aggregate MCP tool limit.");
  }
  const skills = storedArray(binding.skills, "Bot bound skills", BOT_CAPABILITY_LIMITS.skills)
    .map(parseBoundSkill)
    .sort((left, right) => compareText(left.option.id, right.option.id));
  const otherCapabilities = storedArray(
    binding.otherCapabilities,
    "Bot bound ordinary capabilities",
    BOT_CAPABILITY_LIMITS.otherCapabilities,
  )
    .map(parseBoundOther)
    .sort((left, right) => compareText(left.option.id, right.option.id));
  for (const [label, ids] of [
    ["file scopes", fileScopes.map(({ sourceId }) => sourceId)],
    ["connections", connections.map(({ sourceId }) => sourceId)],
    ["skills", skills.map(({ sourceId }) => sourceId)],
    ["ordinary capabilities", otherCapabilities.map(({ kind }) => kind)],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Bot Custom binding contains duplicate ${label}.`);
    }
  }
  const hasShell = Object.prototype.hasOwnProperty.call(binding, "shell");
  const parsed: BoundBotCustomSelection = {
    version: BOT_CAPABILITY_BINDING_VERSION,
    catalogRevision: binding.catalogRevision,
    selection: {
      ...selection,
      fileScopeIds: [...selection.fileScopeIds].sort(compareText),
      connectionIds: [...selection.connectionIds].sort(compareText),
      skillIds: [...selection.skillIds].sort(compareText),
      otherCapabilityIds: [...selection.otherCapabilityIds].sort(compareText),
    },
    provider,
    fileScopes,
    ...(hasShell ? { shell: parseBoundShell(binding.shell) } : {}),
    connections,
    skills,
    otherCapabilities,
  };
  selectionMatchesBinding(parsed);
  // Reuse the public projection's private-key, path-copy, Unicode, and aggregate guards.
  finalizeBotCapabilityCatalog({
    providers: [
      {
        ...parsed.provider.providerOption,
        models: [{ ...parsed.provider.modelOption }],
      },
    ],
    fileScopes: parsed.fileScopes.map(({ option }) => ({ ...option })),
    shellAvailable: Boolean(parsed.shell),
    connections: parsed.connections.map(({ option }) => ({ ...option })),
    skills: parsed.skills.map(({ option }) => ({ ...option })),
    otherCapabilities: parsed.otherCapabilities.map(({ option }) => ({ ...option })),
    notice: {
      version: "bot-full-access-v1",
      requiresAcknowledgement: true,
    },
  });
  return parsed;
}

export function cloneBoundBotCustomSelection(
  binding: BoundBotCustomSelection,
): BoundBotCustomSelection {
  return parseBoundBotCustomSelection(binding);
}

/** Verify persisted opaque ids with the same private key after a restart. */
export function assertBoundBotCustomSelectionOpaqueIds(
  value: BoundBotCustomSelection,
  mintOpaqueId: BotCapabilityOpaqueIdMint,
): void {
  const binding = parseBoundBotCustomSelection(value);
  const idsMatch =
    opaqueIdMatchesMint(
      mintOpaqueId,
      "provider",
      binding.provider.sourceProviderId,
      binding.provider.providerExactFingerprint,
      binding.provider.providerOption.id,
    ) &&
    opaqueIdMatchesMint(
      mintOpaqueId,
      "model",
      `${binding.provider.sourceProviderId}\0${binding.provider.sourceModelId}`,
      binding.provider.modelExactFingerprint,
      binding.provider.modelOption.id,
    ) &&
    binding.fileScopes.every((scope) =>
      opaqueIdMatchesMint(mintOpaqueId, "file", scope.sourceId, scope.exactFingerprint, scope.option.id),
    ) &&
    binding.connections.every((connection) =>
      opaqueIdMatchesMint(
        mintOpaqueId,
        "connection",
        connection.sourceId,
        connection.exactFingerprint,
        connection.option.id,
      ),
    ) &&
    binding.skills.every((skill) =>
      opaqueIdMatchesMint(
        mintOpaqueId,
        "skill",
        skill.sourceId,
        skill.exactFingerprint,
        skill.option.id,
      ),
    ) &&
    binding.otherCapabilities.every((capability) =>
      opaqueIdMatchesMint(
        mintOpaqueId,
        "other",
        capability.kind,
        capability.exactFingerprint,
        capability.option.id,
      ),
    );
  if (!idsMatch) {
    throw new Error("Bot Custom binding opaque ids do not match their persisted exact facts.");
  }
}

function cloneModel(model: BotCatalogModelResource): BotCatalogModelResource {
  return { ...model, option: { ...model.option } };
}

function cloneProvider(provider: BotCatalogProviderResource): BotCatalogProviderResource {
  const models = provider.models.map(cloneModel);
  return {
    ...provider,
    models,
    option: {
      ...provider.option,
      models: models.map(({ option }) => ({ ...option })),
    },
  };
}

function cloneConnection(connection: BotCatalogConnectionResource): BotCatalogConnectionResource {
  return {
    ...connection,
    option: { ...connection.option },
    tools: connection.tools.map((tool) => ({ ...tool })),
  };
}

function cloneSkill(skill: BotCatalogSkillResource): BotCatalogSkillResource {
  return { ...skill, option: { ...skill.option } };
}

function cloneFileScope(scope: BotCatalogFileScopeResource): BotCatalogFileScopeResource {
  return { ...scope, option: { ...scope.option } };
}

function cloneOther(
  capability: BotCatalogOrdinaryCapabilityResource,
): BotCatalogOrdinaryCapabilityResource {
  return { ...capability, option: { ...capability.option } };
}

function fileSelectionIsCoherent(
  selection: BotCustomSelection,
  snapshot: BotCapabilityCatalogSnapshot,
): boolean {
  return botFileScopeSelectionIsCoherent(
    selection.fileScopeIds,
    snapshot.resources.fileScopes.map(({ option }) => option),
  );
}

function bindProvider(
  selection: BotCustomSelection,
  snapshot: BotCapabilityCatalogSnapshot,
): BoundBotProviderModel {
  const provider = snapshot.resources.providers.find(
    ({ option }) => option.id === selection.providerId,
  );
  const model = provider?.models.find(({ option }) => option.id === selection.modelId);
  if (!provider || !model || !provider.option.available || !model.option.available) {
    throw new BotCapabilityValidationError(
      "Bot Custom access contains an unavailable AI connection.",
    );
  }
  const { models: _models, ...providerOption } = provider.option;
  void _models;
  return {
    providerOption: { ...providerOption },
    modelOption: { ...model.option },
    sourceProviderId: provider.sourceId,
    sourceModelId: model.sourceId,
    connectionFingerprint: provider.connectionFingerprint,
    providerExactFingerprint: provider.exactFingerprint,
    modelFingerprint: model.modelFingerprint,
    modelExactFingerprint: model.exactFingerprint,
  };
}

/** Bind one renderer-safe provider/model pair without granting any other capability. */
export function bindBotProviderModel(input: {
  providerId: string;
  modelId: string;
  catalogRevision: string;
  snapshot: BotCapabilityCatalogSnapshot;
  requireImages?: boolean;
}): BoundBotProviderModel {
  if (input.catalogRevision !== input.snapshot.catalog.revision) {
    throw new BotCapabilityValidationError(
      "Bot capability choices changed. Review the current choices and try again.",
    );
  }
  const binding = bindProvider({
    providerId: input.providerId,
    modelId: input.modelId,
    fileScopeIds: [],
    shellEnabled: false,
    connectionIds: [],
    skillIds: [],
    otherCapabilityIds: [],
  }, input.snapshot);
  if (input.requireImages === true && binding.modelOption.supportsImages !== true) {
    throw new BotCapabilityValidationError(
      "The companion model must support image input.",
    );
  }
  return binding;
}

/** Bind renderer-safe positive selections to exact current main-owned facts. */
export function bindBotCustomSelection(input: {
  selection: unknown;
  catalogRevision: string;
  snapshot: BotCapabilityCatalogSnapshot;
}): BoundBotCustomSelection {
  if (input.catalogRevision !== input.snapshot.catalog.revision) {
    throw new BotCapabilityValidationError(
      "Bot capability choices changed. Review the current choices and try again.",
    );
  }
  const selection = parseBotCustomSelection(input.selection);
  validateSelectionAgainstCatalog(selection, input.snapshot.catalog);
  if (!fileSelectionIsCoherent(selection, input.snapshot)) {
    throw new BotCapabilityValidationError(BOT_FILE_SCOPE_SELECTION_GUIDANCE);
  }
  const byOptionId = <T extends { option: { id: string; available: boolean } }>(
    choices: readonly T[],
    ids: readonly string[],
    label: string,
  ): T[] =>
    ids.map((id) => {
      const choice = choices.find(({ option }) => option.id === id);
      if (!choice?.option.available) {
        throw new BotCapabilityValidationError(
          `Bot Custom access contains an unavailable ${label}.`,
        );
      }
      return choice;
    });
  const fileScopes = byOptionId(
    input.snapshot.resources.fileScopes,
    selection.fileScopeIds,
    "file scope",
  );
  const connections = byOptionId(
    input.snapshot.resources.connections,
    selection.connectionIds,
    "connection",
  );
  const skills = byOptionId(input.snapshot.resources.skills, selection.skillIds, "skill");
  const otherCapabilities = byOptionId(
    input.snapshot.resources.otherCapabilities,
    selection.otherCapabilityIds,
    "capability",
  );
  if (selection.shellEnabled && !input.snapshot.resources.shell.available) {
    throw new BotCapabilityValidationError("Bot Custom access enables unavailable shell access.");
  }
  const normalizedSelection: BotCustomSelection = {
    ...selection,
    fileScopeIds: [...selection.fileScopeIds].sort(compareText),
    connectionIds: [...selection.connectionIds].sort(compareText),
    skillIds: [...selection.skillIds].sort(compareText),
    otherCapabilityIds: [...selection.otherCapabilityIds].sort(compareText),
  };
  return {
    version: BOT_CAPABILITY_BINDING_VERSION,
    catalogRevision: input.snapshot.catalog.revision,
    selection: normalizedSelection,
    provider: bindProvider(normalizedSelection, input.snapshot),
    fileScopes: fileScopes
      .map(
        (scope): BoundBotFileScope => ({
          option: { ...scope.option },
          sourceId: scope.sourceId,
          scopeFingerprint: scope.scopeFingerprint,
          exactFingerprint: scope.exactFingerprint,
        }),
      )
      .sort((left, right) => compareText(left.option.id, right.option.id)),
    ...(selection.shellEnabled
      ? {
          shell: {
            shellFingerprint: input.snapshot.resources.shell.shellFingerprint,
            exactFingerprint: input.snapshot.resources.shell.exactFingerprint,
          },
        }
      : {}),
    connections: connections
      .map(
        (connection): BoundBotConnection => ({
          option: { ...connection.option },
          sourceId: connection.sourceId,
          connectionFingerprint: connection.connectionFingerprint,
          toolsetFingerprint: connection.toolsetFingerprint,
          exactFingerprint: connection.exactFingerprint,
          tools: connection.tools.map((tool) => ({ ...tool })),
        }),
      )
      .sort((left, right) => compareText(left.option.id, right.option.id)),
    skills: skills
      .map(
        (skill): BoundBotSkill => ({
          option: { ...skill.option },
          sourceId: skill.sourceId,
          identityFingerprint: skill.identityFingerprint,
          contentFingerprint: skill.contentFingerprint,
          exactFingerprint: skill.exactFingerprint,
        }),
      )
      .sort((left, right) => compareText(left.option.id, right.option.id)),
    otherCapabilities: otherCapabilities
      .map(
        (capability): BoundBotOrdinaryCapability => ({
          option: { ...capability.option },
          kind: capability.kind,
          capabilityFingerprint: capability.capabilityFingerprint,
          exactFingerprint: capability.exactFingerprint,
        }),
      )
      .sort((left, right) => compareText(left.option.id, right.option.id)),
  };
}

function issue(
  group: BotCapabilityDriftGroup,
  selectionId: string | undefined,
  reason: BotCapabilityDriftIssue["reason"],
): BotCapabilityDriftIssue {
  return {
    group,
    ...(selectionId === undefined ? {} : { selectionId }),
    reason,
  };
}

function resourceIssue(
  group: BotCapabilityDriftGroup,
  selectionId: string,
  expectedFingerprint: string,
  current: { option: { available: boolean }; exactFingerprint: string } | undefined,
): BotCapabilityDriftIssue | undefined {
  if (!current || current.exactFingerprint !== expectedFingerprint) {
    return issue(group, selectionId, "changed_or_removed");
  }
  return current.option.available ? undefined : issue(group, selectionId, "unavailable");
}

function findByIdOrSource<T extends { option: { id: string }; sourceId: string }>(
  items: readonly T[],
  selectionId: string,
  sourceId: string,
): T | undefined {
  return (
    items.find((item) => item.option.id === selectionId) ??
    items.find((item) => item.sourceId === sourceId)
  );
}

function adoptRetainedPublicId<T extends { option: { id: string } }>(
  existing: T,
  retainedId: string,
): T {
  if (existing.option.id !== retainedId) {
    existing.option.id = retainedId;
  }
  return existing;
}

function findOrAdoptByIdentity<T extends { option: { id: string } }>(
  collection: T[],
  retainedId: string,
  matchIdentity: (item: T) => boolean,
  label: string,
): T | undefined {
  const byId = collection.find((item) => item.option.id === retainedId);
  if (byId) {
    if (!matchIdentity(byId)) {
      throw new Error(`Bot ${label} opaque id collision detected.`);
    }
    return byId;
  }
  const byIdentity = collection.find(matchIdentity);
  return byIdentity ? adoptRetainedPublicId(byIdentity, retainedId) : undefined;
}

/** Return only public opaque drift facts; private identities never enter error text. */
export function botCustomSelectionDrift(
  binding: BoundBotCustomSelection,
  current: BotCapabilityCatalogSnapshot,
): BotCapabilityDriftIssue[] {
  binding = parseBoundBotCustomSelection(binding);
  const issues: BotCapabilityDriftIssue[] = [];
  const provider = findByIdOrSource(
    current.resources.providers,
    binding.provider.providerOption.id,
    binding.provider.sourceProviderId,
  );
  if (
    !provider ||
    provider.sourceId !== binding.provider.sourceProviderId ||
    provider.exactFingerprint !== binding.provider.providerExactFingerprint
  ) {
    issues.push(issue("provider", binding.provider.providerOption.id, "changed_or_removed"));
  } else if (!provider.option.available) {
    issues.push(issue("provider", binding.provider.providerOption.id, "unavailable"));
  }
  const model = provider
    ? findByIdOrSource(
        provider.models,
        binding.provider.modelOption.id,
        binding.provider.sourceModelId,
      )
    : undefined;
  if (
    !model ||
    model.sourceId !== binding.provider.sourceModelId ||
    model.exactFingerprint !== binding.provider.modelExactFingerprint ||
    model.option.supportsImages !== binding.provider.modelOption.supportsImages
  ) {
    issues.push(issue("model", binding.provider.modelOption.id, "changed_or_removed"));
  } else if (!model.option.available) {
    issues.push(issue("model", binding.provider.modelOption.id, "unavailable"));
  }
  if (binding.shell) {
    if (current.resources.shell.exactFingerprint !== binding.shell.exactFingerprint) {
      issues.push(issue("shell", undefined, "changed_or_removed"));
    } else if (!current.resources.shell.available) {
      issues.push(issue("shell", undefined, "unavailable"));
    }
  }
  for (const bound of binding.fileScopes) {
    const found = findByIdOrSource(current.resources.fileScopes, bound.option.id, bound.sourceId);
    const foundIssue = found?.sourceId !== bound.sourceId
      ? issue("file_scope", bound.option.id, "changed_or_removed")
      : resourceIssue("file_scope", bound.option.id, bound.exactFingerprint, found);
    if (foundIssue) issues.push(foundIssue);
  }
  for (const bound of binding.connections) {
    const found = findByIdOrSource(
      current.resources.connections,
      bound.option.id,
      bound.sourceId,
    );
    const foundIssue = found?.sourceId !== bound.sourceId
      ? issue("connection", bound.option.id, "changed_or_removed")
      : resourceIssue("connection", bound.option.id, bound.exactFingerprint, found);
    if (foundIssue) issues.push(foundIssue);
  }
  for (const bound of binding.skills) {
    const found = findByIdOrSource(current.resources.skills, bound.option.id, bound.sourceId);
    const foundIssue = found?.sourceId !== bound.sourceId
      ? issue("skill", bound.option.id, "changed_or_removed")
      : resourceIssue("skill", bound.option.id, bound.exactFingerprint, found);
    if (foundIssue) issues.push(foundIssue);
  }
  for (const bound of binding.otherCapabilities) {
    const found = current.resources.otherCapabilities.find(
      (capability) =>
        capability.option.id === bound.option.id || capability.kind === bound.kind,
    );
    const foundIssue = resourceIssue(
      "other_capability",
      bound.option.id,
      bound.exactFingerprint,
      found?.kind === bound.kind ? found : undefined,
    );
    if (foundIssue) issues.push(foundIssue);
  }
  return issues.sort(
    (left, right) =>
      compareText(left.group, right.group) ||
      compareText(left.selectionId ?? "", right.selectionId ?? ""),
  );
}

export function assertBoundBotCustomSelectionCurrent(
  binding: BoundBotCustomSelection,
  current: BotCapabilityCatalogSnapshot,
): void {
  const issues = botCustomSelectionDrift(binding, current);
  if (issues.length > 0) throw new BotCapabilityBindingDriftError(issues);
}

function unavailableOption<T extends BotCapabilityOption>(option: T): T {
  return { ...option, available: false };
}

/**
 * Keep stored public ids visible when a source is gone. Same-identity fingerprint
 * drift keeps the live row available so the user can re-bind; Custom still
 * fail-closes at admit until they save. Distinct sources that hash to one id
 * remain a collision.
 */
export function withBotCapabilityTombstones(
  current: BotCapabilityCatalogSnapshot,
  retainedBindings: readonly BoundBotCustomSelection[],
): BotCapabilityCatalogSnapshot {
  const resources = {
    providers: current.resources.providers.map(cloneProvider),
    fileScopes: current.resources.fileScopes.map(cloneFileScope),
    shell: { ...current.resources.shell },
    connections: current.resources.connections.map(cloneConnection),
    skills: current.resources.skills.map(cloneSkill),
    otherCapabilities: current.resources.otherCapabilities.map(cloneOther),
  };
  for (const candidate of retainedBindings) {
    const binding = parseBoundBotCustomSelection(candidate);
    let provider = findOrAdoptByIdentity(
      resources.providers,
      binding.provider.providerOption.id,
      (candidate) => candidate.sourceId === binding.provider.sourceProviderId,
      "provider",
    );
    if (!provider) {
      provider = {
        sourceId: binding.provider.sourceProviderId,
        connectionFingerprint: binding.provider.connectionFingerprint,
        exactFingerprint: binding.provider.providerExactFingerprint,
        models: [],
        option: {
          ...binding.provider.providerOption,
          available: false,
          models: [],
        },
      };
      resources.providers.push(provider);
    }
    const model = findOrAdoptByIdentity(
      provider.models,
      binding.provider.modelOption.id,
      (candidate) => candidate.sourceId === binding.provider.sourceModelId,
      "model",
    );
    if (!model) {
      provider.models.push({
        sourceId: binding.provider.sourceModelId,
        modelFingerprint: binding.provider.modelFingerprint,
        exactFingerprint: binding.provider.modelExactFingerprint,
        option: unavailableOption(binding.provider.modelOption),
      });
    }
    provider.models.sort((left, right) => compareText(left.option.id, right.option.id));
    provider.option.models = provider.models.map(({ option }) => ({ ...option }));

    const appendResource = <T extends { option: BotCapabilityOption }>(
      collection: T[],
      retained: T,
      label: string,
      matchIdentity: (item: T) => boolean,
    ) => {
      const existing = findOrAdoptByIdentity(collection, retained.option.id, matchIdentity, label);
      if (existing) return;
      collection.push({ ...retained, option: unavailableOption(retained.option) });
    };
    for (const scope of binding.fileScopes) {
      appendResource(
        resources.fileScopes,
        {
          option: { ...scope.option },
          sourceId: scope.sourceId,
          scopeFingerprint: scope.scopeFingerprint,
          exactFingerprint: scope.exactFingerprint,
        },
        "file-scope",
        (item) => item.sourceId === scope.sourceId,
      );
    }
    for (const connection of binding.connections) {
      appendResource(
        resources.connections,
        {
          ...connection,
          option: { ...connection.option },
          tools: connection.tools.map((tool) => ({ ...tool })),
        },
        "connection",
        (item) => item.sourceId === connection.sourceId,
      );
    }
    for (const skill of binding.skills) {
      appendResource(
        resources.skills,
        { ...skill, option: { ...skill.option } },
        "skill",
        (item) => item.sourceId === skill.sourceId,
      );
    }
    for (const capability of binding.otherCapabilities) {
      appendResource(
        resources.otherCapabilities,
        { ...capability, option: { ...capability.option } },
        "ordinary-capability",
        (item) => item.kind === capability.kind,
      );
    }
  }
  const modelCount = resources.providers.reduce(
    (total, provider) => total + provider.models.length,
    0,
  );
  if (
    resources.providers.length > BOT_CAPABILITY_LIMITS.providers ||
    resources.providers.some(
      ({ models }) => models.length > BOT_CAPABILITY_LIMITS.modelsPerProvider,
    ) ||
    modelCount > BOT_CAPABILITY_LIMITS.modelsTotal ||
    resources.fileScopes.length > BOT_CAPABILITY_LIMITS.fileScopes ||
    resources.connections.length > BOT_CAPABILITY_LIMITS.connections ||
    resources.skills.length > BOT_CAPABILITY_LIMITS.skills ||
    resources.otherCapabilities.length > BOT_CAPABILITY_LIMITS.otherCapabilities
  ) {
    throw new Error("Bot capability tombstones exceed the public catalog limits.");
  }
  resources.providers.sort((left, right) => compareText(left.option.id, right.option.id));
  resources.fileScopes.sort((left, right) => compareText(left.option.id, right.option.id));
  resources.connections.sort((left, right) => compareText(left.option.id, right.option.id));
  resources.skills.sort((left, right) => compareText(left.option.id, right.option.id));
  resources.otherCapabilities.sort((left, right) => compareText(left.option.id, right.option.id));
  const catalog = finalizeBotCapabilityCatalog({
    providers: resources.providers.map(({ option }) => structuredClone(option)),
    fileScopes: resources.fileScopes.map(({ option }) => ({ ...option })),
    shellAvailable: resources.shell.available,
    connections: resources.connections.map(({ option }) => ({ ...option })),
    skills: resources.skills.map(({ option }) => ({ ...option })),
    otherCapabilities: resources.otherCapabilities.map(({ option }) => ({ ...option })),
    notice: current.catalog.notice,
  });
  return { catalog, resources };
}

export function reconcileBoundBotCustomSelection(
  binding: BoundBotCustomSelection,
  current: BotCapabilityCatalogSnapshot,
): ReconciledBotCustomSelection {
  const issues = botCustomSelectionDrift(binding, current);
  return {
    state: issues.length === 0 ? "ready" : "drifted",
    selection: cloneBotCustomSelection(binding.selection),
    issues,
    catalogSnapshot: withBotCapabilityTombstones(current, [binding]),
  };
}

/** Stable private digest useful for crash journals without serializing raw bindings. */
export function boundBotCustomSelectionFingerprint(binding: BoundBotCustomSelection): string {
  binding = parseBoundBotCustomSelection(binding);
  return botCapabilityFactsFingerprint({
    provider: {
      providerId: binding.provider.providerOption.id,
      providerExactFingerprint: binding.provider.providerExactFingerprint,
      modelId: binding.provider.modelOption.id,
      modelExactFingerprint: binding.provider.modelExactFingerprint,
    },
    fileScopes: binding.fileScopes.map(({ option, exactFingerprint }) => ({
      id: option.id,
      exactFingerprint,
    })),
    shell: binding.shell?.exactFingerprint ?? null,
    connections: binding.connections.map(({ option, exactFingerprint }) => ({
      id: option.id,
      exactFingerprint,
    })),
    skills: binding.skills.map(({ option, exactFingerprint }) => ({
      id: option.id,
      exactFingerprint,
    })),
    otherCapabilities: binding.otherCapabilities.map(({ option, exactFingerprint }) => ({
      id: option.id,
      exactFingerprint,
    })),
  });
}
