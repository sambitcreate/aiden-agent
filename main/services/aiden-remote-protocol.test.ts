import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AIDEN_REMOTE_BASE_PATH,
  AIDEN_REMOTE_CAPABILITIES,
  AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION,
  AIDEN_REMOTE_ERROR_CODES,
  AIDEN_REMOTE_EVENT_TYPES,
  AIDEN_REMOTE_MAX_CHAT_MESSAGES,
  AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
  AIDEN_REMOTE_MAX_SERVER_FEATURE_LENGTH,
  AIDEN_REMOTE_MAX_SERVER_FEATURES,
  AIDEN_REMOTE_MAX_SSE_FRAME_BYTES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  type AidenRemoteCapability,
  parseAidenRemoteChatProjection,
  parseAidenRemoteStreamEvent,
  parseAidenSseFrames,
  reconcileAidenSseFrames,
  parseAidenRemoteContractFixture,
} from "./aiden-remote-protocol.js";

const protocolRoot = path.resolve(process.cwd(), "protocol/aiden-remote/v1");

async function json(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(protocolRoot, relativePath), "utf8"));
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

// Keep this authority vector byte-for-byte aligned with
// AidenRemotePhase0Tests.testEndpointAuthorityGrammarMatchesDesktopVectors.
const endpointAuthorityVectors: readonly [string, boolean][] = [
  ["aiden.example.test", true],
  ["localhost", true],
  ["aiden-lan.local", true],
  ["192.168.1.42", true],
  ["192.0.2.1:443", true],
  ["aiden.0", false],
  ["aiden.123", false],
  ["aiden.example.test:1", true],
  ["aiden.example.test:65535", true],
  ["[::]", true],
  ["[::1]", true],
  ["[2001:db8::1]:443", true],
  ["[::ffff:192.0.2.1]", true],
  ["aiden.example.test:0443", false],
  ["aiden.example.test:00001", false],
  ["aiden.example.test:0", false],
  ["aiden.example.test:65536", false],
  ["aiden.example.test:abc", false],
  ["aiden.example.test:", false],
  [":443", false],
  ["aiden.example.test:1:2", false],
  ["aiden.example.test%2eexample.test", false],
  ["aiden.example.test%25", false],
  ["aiden．example.test", false],
  ["aiden\u{0301}.example.test", false],
  ["aiden.example.test\u{0009}", false],
  ["aiden.example.test\u{001f}", false],
  ["aiden.example.test\u{007f}", false],
  ["aiden..example.test", false],
  ["-aiden.example.test", false],
  ["aiden-.example.test", false],
  ["aiden_example.test", false],
  ["123", false],
  ["192.168.001.1", false],
  ["256.1.1.1", false],
  ["[fe80::1%25en0]", false],
  ["[v1.fe]", false],
  ["[::1", false],
  ["[::1]x", false],
  ["::1", false],
  ["[::1]:00001", false],
  ["[::1]:65536", false],
  ["[2001:db8::1::2]", false],
  ["[192.0.2.1::]", false],
  ["[::ffff:192.000.2.1]", false],
  ["[2001:db8:0:0:0:0:0]", false],
];

test("shared Aiden Remote v1 fixture is complete, ordered, and contains no unsafe wire keys", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  assert.equal(fixture.contractRevision, 10);
  assert.equal(fixture.protocolVersion, AIDEN_REMOTE_PROTOCOL_VERSION);
  assert.deepEqual(fixture.capabilities, AIDEN_REMOTE_CAPABILITIES);
  assert.deepEqual(fixture.server.serverCapabilities, AIDEN_REMOTE_CAPABILITIES);
  assert.deepEqual(fixture.server.capabilities, fixture.pairingExchange.capabilities);
  assert.equal(record(fixture.chat, "fixture chat").botId, "bot_fixture_01");
  assert.equal(record(fixture.speechStatus, "fixture speech status").selectedModelId, "parakeet-v3");
  assert.equal(record(fixture.speechTranscription, "fixture speech transcription").modelId, "parakeet-v3");
  assert.equal(
    fixture.botCapabilityCatalog.fileScopes.some((scope) => scope.kind === "full_mac"),
    true,
  );
  assert.deepEqual(
    new Set(fixture.events.map((event) => event.type)),
    new Set(AIDEN_REMOTE_EVENT_TYPES),
  );
  assert.equal(JSON.stringify(fixture).includes("/Users/"), false);
  assert.equal(JSON.stringify(fixture).includes("BEGIN PRIVATE KEY"), false);
});

test("shared manual pairing vector decrypts with the frozen cross-platform construction", async () => {
  const vector = record(await json("fixtures/manual-pairing-vector.json"), "manual vector");
  const bootstrap = record(vector.bootstrap, "manual bootstrap");
  const code = String(vector.code).replace(/-/gu, "");
  const payload = String(vector.payload);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{20}$/u);
  assert.equal(bootstrap.kind, "aiden-manual-pairing-v1");
  assert.equal(bootstrap.protocolVersion, 1);
  assert.match(String(bootstrap.sessionId), /^pairing_[A-Za-z0-9_-]{32}$/u);

  const key = Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(code, "ascii"),
    Buffer.from(String(bootstrap.salt), "base64url"),
    Buffer.from(`aiden-manual-pairing-v1\n${String(bootstrap.sessionId)}`, "utf8"),
    32,
  ));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(bootstrap.nonce), "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(
    `aiden-manual-pairing-v1\n${String(bootstrap.sessionId)}\n${String(bootstrap.expiresAt)}`,
    "utf8",
  ));
  decipher.setAuthTag(Buffer.from(String(bootstrap.tag), "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(bootstrap.ciphertext), "base64url")),
    decipher.final(),
  ]).toString("utf8");
  assert.equal(plaintext, payload);
  assert.equal(JSON.stringify(bootstrap).includes(code), false);
  const decrypted = record(JSON.parse(payload), "pairing payload");
  const pairingBootstrap = record(decrypted.bootstrap, "pairing bootstrap");
  assert.match(String(pairingBootstrap.secret), /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(bootstrap).includes(String(pairingBootstrap.secret)), false);
});

test("OpenAPI freezes every planned route under authenticated Aiden v1 semantics", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  assert.equal(document.openapi, "3.1.0");
  const info = record(document.info, "OpenAPI info");
  assert.equal(info.version, "1.0.0");
  const paths = record(document.paths, "OpenAPI paths");
  const requiredPaths = [
    "/health",
    "/pairing/manual-bootstrap",
    "/pairing/exchange",
    "/server",
    "/device/identity",
    "/workspaces",
    "/workspaces/{workspaceId}",
    "/workspace-browser/roots",
    "/workspace-browser/children",
    "/workspace-browser/selections",
    "/chat-summaries",
    "/chats",
    "/chats/{chatId}",
    "/chats/{chatId}/move",
    "/chats/{chatId}/turns",
    "/chats/{chatId}/attachments",
    "/chats/{chatId}/attachments/{attachmentId}",
    "/chats/{chatId}/attachments/{attachmentId}/content",
    "/bots",
    "/bots/{botId}",
    "/bots/{botId}/restore",
    "/bot-conversations",
    "/bots/{botId}/chats",
    "/bot-capabilities",
    "/bots/{botId}/capabilities",
    "/chats/{chatId}/capabilities",
    "/bot-conversations/{chatId}/files",
    "/bot-conversations/{chatId}/files/{fileId}",
    "/bots/{botId}/avatar",
    "/bots/{botId}/avatar/{assetRevision}",
    "/bot-favorites",
    "/bot-access-notice",
    "/bot-access-notice/acknowledgement",
    "/streams/{streamId}",
    "/streams/{streamId}/events",
    "/streams/{streamId}/approval",
    "/streams/{streamId}/cancel",
    "/approvals/{approvalId}/respond",
    "/models",
    "/speech",
    "/speech/models/{modelId}/download",
    "/speech/models/{modelId}",
    "/speech/transcriptions",
    "/usage",
    "/workspaces/{workspaceId}/files",
    "/workspaces/{workspaceId}/files/{fileId}",
    "/workspaces/{workspaceId}/git/review",
    "/workspaces/{workspaceId}/git/diff",
    "/workspaces/{workspaceId}/git/branches",
    "/workspaces/{workspaceId}/git/checkout",
    "/workspaces/{workspaceId}/git/commit",
    "/workspaces/{workspaceId}/git/push-capability",
    "/workspaces/{workspaceId}/git/push",
    "/workspaces/{workspaceId}/git/compare",
    "/workspaces/{workspaceId}/git/comparison-diff",
    "/workspaces/{workspaceId}/git/worktrees",
    "/workspaces/{workspaceId}/git/managed-worktree",
    "/scheduled-tasks",
    "/scheduled-tasks/{taskId}",
    "/scheduled-tasks/{taskId}/pause",
    "/scheduled-tasks/{taskId}/resume",
    "/scheduled-tasks/{taskId}/run",
    "/scheduled-tasks/{taskId}/runs",
    "/scheduled-tasks/preview",
    "/scheduled-tasks/scripts",
    "/scheduled-tasks/mcp-servers",
    "/memory/settings",
    "/scheduled-tasks/settings",
  ];
  assert.deepEqual(Object.keys(paths), requiredPaths);
  assert.deepEqual(document.security, [{ deviceBearer: [], protocolVersion: [] }]);
  const securitySchemes = record(record(document.components, "components").securitySchemes, "security schemes");
  assert.deepEqual(securitySchemes.protocolVersion, {
    type: "apiKey",
    in: "header",
    name: "Aiden-Protocol-Version",
    description: "Must be exactly 1.",
  });
  const schemas = record(record(document.components, "components").schemas, "schemas");
  const pairingRequestProperties = record(
    record(schemas.PairingExchangeRequest, "PairingExchangeRequest").properties,
    "PairingExchangeRequest properties",
  );
  assert.deepEqual(record(pairingRequestProperties.acceptsBotCapabilities, "acceptsBotCapabilities"), {
    type: "boolean",
    description: "Explicitly accepts the Bot capability vocabulary and the additive serverCapabilities projection. Bot grants are never issued when this field is absent or false.",
  });
  const pairingResponseCapabilities = record(
    record(
      record(schemas.PairingExchangeResponse, "PairingExchangeResponse").properties,
      "PairingExchangeResponse properties",
    ).capabilities,
    "PairingExchangeResponse capabilities",
  );
  assert.deepEqual(record(pairingResponseCapabilities.items, "pairing capability items").enum, AIDEN_REMOTE_CAPABILITIES);
  const serverSchema = record(schemas.Server, "Server");
  const serverProperties = record(
    serverSchema.properties,
    "Server properties",
  );
  assert.deepEqual(
    record(record(serverProperties.capabilities, "device capabilities").items, "device capability items").enum,
    AIDEN_REMOTE_CAPABILITIES,
  );
  assert.deepEqual(
    record(record(serverProperties.serverCapabilities, "server capabilities").items, "server capability items").enum,
    AIDEN_REMOTE_CAPABILITIES,
  );
  assert.equal((serverSchema.required as unknown[]).includes("serverCapabilities"), false);
  assert.equal((serverSchema.required as unknown[]).includes("deviceName"), false);
  const serverFeatures = record(serverProperties.features, "server features");
  assert.equal(serverFeatures.maxItems, AIDEN_REMOTE_MAX_SERVER_FEATURES);
  assert.equal(serverFeatures.uniqueItems, true);
  assert.deepEqual(record(serverFeatures.items, "server feature token"), {
    type: "string",
    minLength: 1,
    maxLength: AIDEN_REMOTE_MAX_SERVER_FEATURE_LENGTH,
    pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
  });
  assert.deepEqual(record(serverProperties.deviceName, "device name"), {
    type: "string",
    description: "Presentation-only label currently stored for the authenticated client device.",
    minLength: 1,
    maxLength: 80,
  });
  const identityPatch = record(
    record(paths["/device/identity"], "device identity").patch,
    "device identity patch",
  );
  assert.equal(identityPatch["x-aiden-capability"], "server:read");
  const chatProperties = record(record(schemas.Chat, "Chat").properties, "Chat properties");
  assert.equal(record(chatProperties.botId, "Chat botId").maxLength, 160);
  const providerSchema = record(schemas.Provider, "Provider schema");
  const providerModels = record(record(providerSchema.properties, "Provider properties").models, "Provider models");
  const modelProperties = record(record(record(providerModels.items, "Provider model").properties, "Provider model properties"), "Provider model properties");
  assert.deepEqual(Object.keys(modelProperties), [
    "id",
    "label",
    "supportsImages",
    "thinkingLevels",
    "defaultThinkingLevel",
    "thinkingCanDisable",
    "hidden",
  ]);
  const healthGet = record(record(paths["/health"], "health").get, "health get");
  assert.deepEqual(healthGet.security, []);
  const pairingPost = record(record(paths["/pairing/exchange"], "pairing").post, "pairing post");
  assert.deepEqual(pairingPost.security, []);
  const manualPairingPost = record(
    record(paths["/pairing/manual-bootstrap"], "manual pairing").post,
    "manual pairing post",
  );
  assert.deepEqual(manualPairingPost.security, []);

  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [route, pathValue] of Object.entries(paths)) {
    if (route !== "/health" && route !== "/pairing/exchange" && route !== "/pairing/manual-bootstrap") {
      const inherited = (record(pathValue, route).parameters as Array<Record<string, unknown>> | undefined) ?? [];
      assert(inherited.some((parameter) => parameter.$ref === "#/components/parameters/ProtocolVersion"), `${route} must require the exact protocol-version header`);
    }
    for (const [method, operationValue] of Object.entries(record(pathValue, route))) {
      if (!methods.has(method)) continue;
      const operationRecord = record(operationValue, `${method} ${route}`);
      if (route === "/health" || route === "/pairing/exchange" || route === "/pairing/manual-bootstrap") continue;
      assert(
        AIDEN_REMOTE_CAPABILITIES.includes(
          operationRecord["x-aiden-capability"] as (typeof AIDEN_REMOTE_CAPABILITIES)[number],
        ),
        `${method} ${route} must name a known capability`,
      );
    }
  }

  const resolveLocalReference = (reference: string): unknown => {
    assert.match(reference, /^#\//, `Only local OpenAPI references are allowed: ${reference}`);
    return reference
      .slice(2)
      .split("/")
      .map((segment) => segment.split("~1").join("/").split("~0").join("~"))
      .reduce<unknown>((current, segment) => record(current, reference)[segment], document);
  };
  const inspectReferences = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspectReferences);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref") {
        if (typeof child !== "string") throw new Error("OpenAPI $ref must be a string.");
        assert.notEqual(resolveLocalReference(child), undefined, `Unresolved OpenAPI reference ${child}`);
      } else {
        inspectReferences(child);
      }
    }
  };
  inspectReferences(document);
});

test("Bot OpenAPI freezes bounded DTOs, conjunctive grants, and privacy-safe routes", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  const paths = record(document.paths, "paths");
  const schemas = record(record(document.components, "components").schemas, "schemas");
  const parameters = record(record(document.components, "components").parameters, "parameters");
  const operation = (route: string, method: string) =>
    record(record(paths[route], route)[method], `${method} ${route}`);
  const responseSchemaRef = (route: string, method: string, status: string) => {
    const responses = record(operation(route, method).responses, `${method} ${route} responses`);
    const response = record(responses[status], `${method} ${route} ${status}`);
    const content = record(response.content, `${method} ${route} ${status} content`);
    return record(record(content["application/json"], "application/json").schema, "response schema").$ref;
  };
  const requestSchemaRef = (route: string, method: string) => {
    const requestBody = record(operation(route, method).requestBody, `${method} ${route} requestBody`);
    const content = record(requestBody.content, `${method} ${route} request content`);
    return record(record(content["application/json"], "application/json").schema, "request schema").$ref;
  };

  assert.deepEqual(
    record(document["x-aiden-json-response-emission"], "JSON response emission"),
    {
      maximumUtf8Bytes: AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
      overflowStatus: 413,
      overflowErrorCode: "payload_too_large",
      atomic: true,
    },
  );
  const privateResponseFields = record(
    document["x-aiden-context-private-response-fields"],
    "context-private response fields",
  );
  assert.deepEqual(privateResponseFields.appliesTo, ["Chat", "ChatSummary", "Bot"]);
  assert.equal(privateResponseFields.recursive, true);
  assert.equal(
    privateResponseFields.normalization,
    "Remove hyphens, underscores, periods, and whitespace, then lowercase before comparison.",
  );
  assert.deepEqual(privateResponseFields.allowedSchemaProperties, [
    "BotDetail.instructions",
    "BotDetail.openingGreeting",
  ]);
  assert.deepEqual(privateResponseFields.chatSummaryOnlyForbiddenNormalizedNames, [
    "messages", "attachments", "htmlartifacts", "outcome", "timeline", "reasoning",
    "botid", "providerid", "modelid", "preview",
  ]);
  assert.deepEqual(privateResponseFields.forbiddenNormalizedNames, [
    "credential", "credentials", "secret", "secrets", "apikey", "token",
    "accesstoken", "refreshtoken", "header", "headers", "endpoint", "path",
    "prompt", "instructions", "openinggreeting", "argument", "arguments", "args",
    "toolargument", "toolarguments", "toolargs", "result", "results", "toolresult",
    "toolresults", "reasoning", "reasoningcontent", "authorization",
    "credentialdigest", "providerfingerprint", "mcpserverbindings", "folderpath",
    "repositorypath", "worktreepath", "worktreegitdir", "ownershiptoken",
    "worktreedevice", "worktreeinode", "createdfromhead", "canonicalpath",
    "absolutepath", "scriptpath", "managedhomepath", "managedworkspacepath",
    "workspacepath", "bothomepath", "systemprompt", "skillcontent", "skillcontents",
    "skillpath", "skillpaths", "providercredential", "mcpcredential",
    "connectioncredential", "authorizationheader", "providerheaders", "mcpheaders",
    "connectionheaders", "providerapikey", "mcpapikey", "connectionapikey",
    "credentialmaterial", "assetfilename", "avatarassetfilename", "temporaryasseturl",
    "temporaryurl", "environment", "stdout", "stderr",
  ]);

  const conjunctiveCapabilities = new Map<string, readonly AidenRemoteCapability[]>([
    ["get /bots", ["bot:read"]],
    ["post /bots", ["bot:read", "bot:write"]],
    ["get /bots/{botId}", ["bot:read"]],
    ["patch /bots/{botId}", ["bot:read", "bot:write"]],
    ["delete /bots/{botId}", ["bot:read", "bot:write"]],
    ["post /bots/{botId}/restore", ["bot:read", "bot:write"]],
    ["get /bot-conversations", ["bot:read", "chat:read"]],
    ["post /bots/{botId}/chats", ["bot:read", "bot:write", "chat:write"]],
    ["get /bot-capabilities", ["bot:read"]],
    ["patch /bots/{botId}/capabilities", ["bot:read", "bot:write"]],
    ["get /chats/{chatId}/capabilities", ["bot:read", "chat:read"]],
    ["patch /chats/{chatId}/capabilities", ["bot:read", "bot:write", "chat:write"]],
    ["get /bot-conversations/{chatId}/files", ["bot:read", "files:read"]],
    ["get /bot-conversations/{chatId}/files/{fileId}", ["bot:read", "files:read"]],
    ["put /bot-conversations/{chatId}/files/{fileId}", ["bot:read", "bot:write", "files:write"]],
    ["put /bots/{botId}/avatar", ["bot:read", "bot:write"]],
    ["delete /bots/{botId}/avatar", ["bot:read", "bot:write"]],
    ["get /bots/{botId}/avatar/{assetRevision}", ["bot:read"]],
    ["get /bot-favorites", ["bot:read"]],
    ["patch /bot-favorites", ["bot:read", "bot:write"]],
    ["get /bot-access-notice", ["bot:read"]],
    ["post /bot-access-notice/acknowledgement", ["bot:read", "bot:write"]],
  ]);
  for (const [operationKey, expected] of conjunctiveCapabilities) {
    const separator = operationKey.indexOf(" ");
    const method = operationKey.slice(0, separator);
    const route = operationKey.slice(separator + 1);
    const value = operation(route, method);
    assert.deepEqual(value["x-aiden-capabilities"], expected, operationKey);
    assert(expected.includes(value["x-aiden-capability"] as AidenRemoteCapability));
  }
  for (const [schemaName, index, field] of [
    ["PairingExchangeResponse", 0, "capabilities"],
    ["Server", 0, "capabilities"],
    ["Server", 1, "serverCapabilities"],
  ] as const) {
    const conditions = record(schemas[schemaName], schemaName).allOf as unknown[];
    const condition = record(conditions[index], `${schemaName} ${field} implication`);
    const whenProperties = record(record(condition.if, "implication if").properties, "implication if properties");
    const thenProperties = record(record(condition.then, "implication then").properties, "implication then properties");
    assert.equal(
      record(record(whenProperties[field], `${field} write`).contains, `${field} write contains`).const,
      "bot:write",
    );
    assert.equal(
      record(record(thenProperties[field], `${field} read`).contains, `${field} read contains`).const,
      "bot:read",
    );
  }

  assert.deepEqual(record(record(parameters.BotId, "BotId").schema, "BotId schema"), {
    type: "string",
    minLength: 1,
    maxLength: 160,
    pattern: "^[A-Za-z0-9._:-]+$",
  });
  assert.deepEqual(record(record(parameters.AssetRevision, "AssetRevision").schema, "AssetRevision schema"), {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9._:-]+$",
  });

  const closedBotSchemas = [
    "BotAvatarAsset",
    "BotAvatarView",
    "BotSummary",
    "BotFavoritesView",
    "BotList",
    "BotCapabilityOption",
    "BotFileScopeOption",
    "BotProviderModelOption",
    "BotProviderOption",
    "BotCapabilityCatalog",
    "BotCustomSelection",
    "BotDetail",
    "BotCreateRequest",
    "BotIdentityPatch",
    "BotConversationItem",
    "BotConversationPage",
    "BotFavoritesUpdateRequest",
    "BotAccessNoticeAcknowledgementRequest",
    "BotAvatarUploadRequest",
  ];
  for (const name of closedBotSchemas) {
    assert.equal(record(schemas[name], name).additionalProperties, false, `${name} must be closed`);
  }
  for (const name of [
    "BotAccessNoticeStatus",
    "BotAccessView",
    "BotAccessUpdateRequest",
    "ChatBotAccessView",
    "ChatBotAccessUpdateRequest",
    "BotChatCreateRequest",
  ]) {
    const variants = record(schemas[name], name).oneOf;
    assert(Array.isArray(variants));
    assert.equal(variants.length, 2);
    variants.forEach((variant, index) => {
      assert.equal(record(variant, `${name}[${index}]`).additionalProperties, false);
    });
  }
  const avatarVariants = record(schemas.BotSemanticAvatar, "BotSemanticAvatar").oneOf;
  assert(Array.isArray(avatarVariants));
  assert.deepEqual(record(avatarVariants[0], "legacy avatar").enum, ["spark", "orbit", "leaf", "prism", "wave", "ember"]);
  assert.equal(record(avatarVariants[1], "v1 avatar").additionalProperties, false);

  const botSummary = record(schemas.BotSummary, "BotSummary");
  const botSummaryProperties = record(botSummary.properties, "BotSummary properties");
  assert.deepEqual(botSummary.required, ["id", "name", "purpose", "avatar", "health", "createdAt", "updatedAt", "revision"]);
  assert.equal("instructions" in botSummaryProperties, false, "Bot summaries must not expose instructions");
  assert.equal(record(botSummaryProperties.id, "BotSummary id").maxLength, 160);
  assert.equal(record(botSummaryProperties.purpose, "BotSummary purpose").maxLength, 280);
  assert.equal(botSummary["x-aiden-updated-at-not-before-created-at"], true);
  assert.deepEqual(record(schemas.BotHealth, "BotHealth").enum, ["ready", "degraded", "unavailable", "archived"]);
  for (const name of ["BotSummary", "BotDetail"]) {
    const healthCondition = record((record(schemas[name], name).allOf as unknown[])[0], `${name} health condition`);
    assert.deepEqual(record(healthCondition.then, `${name} archived branch`).required, ["archivedAt"]);
    assert.deepEqual(record(record(healthCondition.else, `${name} active branch`).not, `${name} active exclusion`).required, ["archivedAt"]);
  }
  const botListProperties = record(record(schemas.BotList, "BotList").properties, "BotList properties");
  assert.equal(record(botListProperties.bots, "Bot list items").maxItems, 256);
  assert.equal(record(botListProperties.maxBots, "Bot list maximum").const, 256);
  assert.equal(record(schemas.BotList, "BotList")["x-aiden-favorites-exclude-archived-bots"], true);
  assert.equal(record(schemas.BotFavoritesView, "BotFavoritesView")["x-aiden-excludes-archived-bots"], true);

  const botDetailProperties = record(record(schemas.BotDetail, "BotDetail").properties, "BotDetail properties");
  assert.equal(record(schemas.BotDetail, "BotDetail")["x-aiden-updated-at-not-before-created-at"], true);
  assert.equal(record(botDetailProperties.instructions, "instructions").maxLength, 32_000);
  assert.equal(record(botDetailProperties.openingGreeting, "openingGreeting").maxLength, 2_000);
  assert.equal(record(botDetailProperties.access, "Bot access").$ref, "#/components/schemas/BotAccessView");
  const botModelSelection = record(botDetailProperties.modelSelection, "Bot model selection");
  assert.deepEqual(botModelSelection.required, ["providerId", "modelId"]);
  const createRequest = record(schemas.BotCreateRequest, "BotCreateRequest");
  assert.equal(createRequest["x-aiden-provider-model-must-be-currently-available"], true);
  assert.deepEqual(createRequest.required, ["name", "purpose", "instructions", "avatar", "access"]);
  assert.deepEqual(Object.keys(record(createRequest.properties, "BotCreateRequest properties")), ["name", "purpose", "openingGreeting", "instructions", "avatar", "access"]);
  assert.equal(
    record(record(createRequest.properties, "BotCreateRequest properties").access, "create access").$ref,
    "#/components/schemas/BotAccessUpdateRequest",
  );
  const identityPatch = record(schemas.BotIdentityPatch, "BotIdentityPatch");
  assert.equal(identityPatch.minProperties, 1);
  assert.deepEqual(Object.keys(record(identityPatch.properties, "BotIdentityPatch properties")), ["name", "purpose", "openingGreeting", "instructions", "avatar"]);

  const conversationPageProperties = record(record(schemas.BotConversationPage, "BotConversationPage").properties, "BotConversationPage properties");
  assert.equal(record(conversationPageProperties.conversations, "conversations").maxItems, 50);
  const conversationProperties = record(record(schemas.BotConversationItem, "BotConversationItem").properties, "BotConversationItem properties");
  assert.equal(record(schemas.BotConversationItem, "BotConversationItem")["x-aiden-updated-at-not-before-created-at"], true);
  assert.equal(record(conversationProperties.preview, "preview").maxLength, 500);
  assert.deepEqual(record(conversationProperties.activityState, "activityState").enum, ["idle", "queued", "running", "waiting_for_approval", "reconciling"]);
  const approvalCondition = record((record(schemas.BotConversationItem, "BotConversationItem").allOf as unknown[])[0], "approval response condition");
  const approvalConditionProperties = record(record(approvalCondition.if, "approval condition").properties, "approval condition properties");
  const approvalConsequenceProperties = record(record(approvalCondition.then, "approval consequence").properties, "approval consequence properties");
  assert.equal(record(approvalConditionProperties.canRespondToApproval, "canRespondToApproval condition").const, true);
  assert.equal(record(approvalConsequenceProperties.activityState, "activityState consequence").const, "waiting_for_approval");
  const conversationParameters = operation("/bot-conversations", "get").parameters as Array<Record<string, unknown>>;
  const queryParameter = (name: string) => record(conversationParameters.find((parameter) => parameter.name === name), `${name} parameter`);
  assert.equal(record(queryParameter("query").schema, "query schema").maxLength, 200);
  assert.equal(record(queryParameter("botId").schema, "botId schema").maxLength, 160);
  assert.deepEqual(record(queryParameter("limit").schema, "limit schema"), { type: "integer", minimum: 1, maximum: 50, default: 30 });

  const catalogProperties = record(record(schemas.BotCapabilityCatalog, "BotCapabilityCatalog").properties, "BotCapabilityCatalog properties");
  assert.deepEqual(Object.keys(catalogProperties), ["revision", "providers", "fileScopes", "shellAvailable", "connections", "skillsEnabled", "skills", "otherCapabilities", "notice"]);
  assert.equal(record(catalogProperties.providers, "providers").maxItems, 64);
  assert.equal(
    record(catalogProperties.providers, "providers")["x-aiden-max-total-models"],
    512,
  );
  assert.equal(record(catalogProperties.connections, "connections").maxItems, 128);
  assert.equal(record(catalogProperties.skills, "skills").maxItems, 256);
  assert.equal(record(catalogProperties.skillsEnabled, "skillsEnabled").type, "boolean");
  assert.equal(record(catalogProperties.skillsEnabled, "skillsEnabled").default, true);
  assert.equal(record(catalogProperties.notice, "notice").$ref, "#/components/schemas/BotAccessNoticeStatus");
  const customSelection = record(schemas.BotCustomSelection, "BotCustomSelection");
  assert.deepEqual(customSelection.required, ["providerId", "modelId", "fileScopeIds", "shellEnabled", "connectionIds", "skillIds", "otherCapabilityIds"]);
  const customProperties = record(customSelection.properties, "BotCustomSelection properties");
  for (const field of ["fileScopeIds", "connectionIds", "skillIds", "otherCapabilityIds"]) {
    assert.equal(record(record(customProperties[field], field).items, `${field} items`).pattern, "^[A-Za-z0-9._:-]+$");
  }
  for (const name of ["BotCapabilityOption", "BotFileScopeOption"]) {
    const optionProperties = record(record(schemas[name], name).properties, `${name} properties`);
    assert.equal(record(optionProperties.id, `${name} id`).pattern, "^[A-Za-z0-9._:-]+$");
  }
  const botAccessVariants = record(schemas.BotAccessView, "BotAccessView").oneOf as unknown[];
  const fullAccess = record(botAccessVariants[0], "full BotAccessView");
  const customAccess = record(botAccessVariants[1], "custom BotAccessView");
  assert.equal(record(record(fullAccess.properties, "full access properties").accessMode, "full mode").const, "full");
  assert.equal("custom" in record(fullAccess.properties, "full access properties"), false);
  assert.equal(record(record(customAccess.properties, "custom access properties").accessMode, "custom mode").const, "custom");
  assert((customAccess.required as unknown[]).includes("custom"));
  const chatAccessVariants = record(schemas.ChatBotAccessView, "ChatBotAccessView").oneOf as unknown[];
  const inheritedAccess = record(chatAccessVariants[0], "inherited ChatBotAccessView");
  const reducedAccess = record(chatAccessVariants[1], "custom ChatBotAccessView");
  assert.equal(record(record(inheritedAccess.properties, "inherit properties").mode, "inherit mode").const, "inherit");
  assert.equal("custom" in record(inheritedAccess.properties, "inherit properties"), false);
  assert.equal(record(record(reducedAccess.properties, "custom chat properties").mode, "custom chat mode").const, "custom");
  assert((reducedAccess.required as unknown[]).includes("custom"));
  const botUpdateVariants = record(schemas.BotAccessUpdateRequest, "BotAccessUpdateRequest").oneOf as unknown[];
  assert.deepEqual(record(botUpdateVariants[0], "full Bot update").required, [
    "accessMode",
    "catalogRevision",
    "confirmedForeground",
  ]);
  assert.deepEqual(record(botUpdateVariants[0], "full Bot update").dependentRequired, {
    providerId: ["modelId"],
    modelId: ["providerId"],
  });
  assert.deepEqual(record(botUpdateVariants[1], "custom Bot update").required, [
    "accessMode",
    "catalogRevision",
    "custom",
  ]);
  const chatUpdateVariants = record(schemas.ChatBotAccessUpdateRequest, "ChatBotAccessUpdateRequest").oneOf as unknown[];
  assert.deepEqual(record(chatUpdateVariants[0], "inherit chat update").required, [
    "mode",
    "catalogRevision",
    "expectedBotPolicyRevision",
  ]);
  assert.deepEqual(record(chatUpdateVariants[1], "custom chat update").required, [
    "mode",
    "catalogRevision",
    "expectedBotPolicyRevision",
    "custom",
  ]);
  const botChatCreateVariants = record(schemas.BotChatCreateRequest, "BotChatCreateRequest").oneOf as unknown[];
  assert.equal(record(schemas.BotChatCreateRequest, "BotChatCreateRequest")["x-aiden-provider-model-must-be-currently-available"], true);
  assert.equal(record(botChatCreateVariants[0], "inherited Bot chat create").maxProperties, 0);
  assert.deepEqual(record(botChatCreateVariants[1], "selected Bot chat create").required, [
    "providerId",
    "modelId",
  ]);
  const noticeVariants = record(schemas.BotAccessNoticeStatus, "BotAccessNoticeStatus").oneOf as unknown[];
  const pendingNotice = record(noticeVariants[0], "pending notice");
  const acceptedNotice = record(noticeVariants[1], "accepted notice");
  assert.equal(record(record(pendingNotice.properties, "pending notice properties").requiresAcknowledgement, "pending acknowledgement").const, true);
  assert.equal(
    record(record(pendingNotice.properties, "pending notice properties").version, "pending version").const,
    AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION,
  );
  assert.equal("acceptedAt" in record(pendingNotice.properties, "pending notice properties"), false);
  assert.equal(record(record(acceptedNotice.properties, "accepted notice properties").requiresAcknowledgement, "accepted acknowledgement").const, false);
  assert.equal(
    record(record(acceptedNotice.properties, "accepted notice properties").version, "accepted version").const,
    AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION,
  );
  assert.deepEqual(acceptedNotice.required, ["version", "requiresAcknowledgement", "acceptedAt", "acceptedDecision"]);
  assert.deepEqual(record(record(acceptedNotice.properties, "accepted notice properties").acceptedDecision, "acceptedDecision").enum, ["continue_full", "customize_first"]);
  const acknowledgementProperties = record(record(schemas.BotAccessNoticeAcknowledgementRequest, "BotAccessNoticeAcknowledgementRequest").properties, "ack properties");
  assert.equal(
    record(acknowledgementProperties.version, "ack version").const,
    AIDEN_REMOTE_BOT_ACCESS_NOTICE_VERSION,
  );
  assert.deepEqual(record(acknowledgementProperties.decision, "decision").enum, ["continue_full", "customize_first"]);
  assert.equal(record(acknowledgementProperties.confirmedForeground, "confirmedForeground").const, true);

  const avatarAssetProperties = record(record(schemas.BotAvatarAsset, "BotAvatarAsset").properties, "BotAvatarAsset properties");
  assert.equal(record(avatarAssetProperties.mimeType, "avatar MIME").const, "image/png");
  assert.equal(record(avatarAssetProperties.width, "avatar width").const, 512);
  assert.equal(record(avatarAssetProperties.height, "avatar height").const, 512);
  assert.equal(record(avatarAssetProperties.byteSize, "avatar bytes").maximum, 4_194_304);
  const avatarUploadProperties = record(record(schemas.BotAvatarUploadRequest, "BotAvatarUploadRequest").properties, "BotAvatarUploadRequest properties");
  assert.equal(record(avatarUploadProperties.data, "avatar data").maxLength, 5_592_408);
  const avatarContent = record(record(operation("/bots/{botId}/avatar/{assetRevision}", "get").responses, "avatar responses")["200"], "avatar 200");
  const avatarHeaders = record(avatarContent.headers, "avatar headers");
  assert.deepEqual(Object.keys(record(avatarContent.content, "avatar content")), ["image/png"]);
  assert.equal(record(record(avatarHeaders["Cache-Control"], "Cache-Control").schema, "Cache-Control schema").const, "no-store");
  assert.equal(record(record(avatarHeaders["X-Content-Type-Options"], "X-Content-Type-Options").schema, "nosniff schema").const, "nosniff");

  const chatSchema = record(schemas.Chat, "Chat");
  const chatProperties = record(chatSchema.properties, "Chat properties");
  for (const field of ["id", "workspaceId", "revision"]) {
    assert.equal(record(chatProperties[field], `Chat ${field}`).maxLength, 128);
  }
  assert.equal(record(chatProperties.title, "Chat title").maxLength, 1_024);
  assert.equal(record(chatProperties.providerId, "Chat providerId").maxLength, 256);
  assert.equal(record(chatProperties.modelId, "Chat modelId").maxLength, 512);
  assert.equal(record(chatProperties.messages, "Chat messages").maxItems, AIDEN_REMOTE_MAX_CHAT_MESSAGES);
  assert.equal(chatSchema["x-aiden-max-json-response-bytes"], AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES);
  assert.equal(chatSchema["x-aiden-updated-at-not-before-created-at"], true);
  assert.deepEqual(chatSchema.dependentRequired, {
    providerId: ["modelId"],
    modelId: ["providerId"],
  });
  const botChatCreateResponse = record(schemas.BotChatCreateResponse, "BotChatCreateResponse");
  const botChatCreateResponseParts = botChatCreateResponse.allOf as unknown[];
  assert.equal(record(botChatCreateResponseParts[0], "Bot chat response Chat").$ref, "#/components/schemas/Chat");
  assert.deepEqual(record(botChatCreateResponseParts[1], "Bot chat response identity").required, ["botId"]);
  assert.equal(operation("/bots", "post")["x-aiden-provider-model-must-be-currently-available"], true);
  assert.equal(operation("/bots/{botId}/chats", "post")["x-aiden-provider-model-must-be-currently-available"], true);
  assert.equal(operation("/bots/{botId}/chats", "post")["x-aiden-canonical-chat-per-bot"], true);
  assert.equal(operation("/bots/{botId}/chats", "post")["x-aiden-provider-model-required-only-when-creating"], true);
  const messageProperties = record(record(schemas.Message, "Message").properties, "Message properties");
  assert.equal(record(messageProperties.id, "Message id").minLength, 1);
  assert.equal(record(messageProperties.id, "Message id").maxLength, 128);

  for (const [route, method, schema] of [
    ["/bots", "post", "BotCreateRequest"],
    ["/bots/{botId}", "patch", "BotIdentityPatch"],
    ["/bots/{botId}/chats", "post", "BotChatCreateRequest"],
    ["/bots/{botId}/capabilities", "patch", "BotAccessUpdateRequest"],
    ["/chats/{chatId}/capabilities", "patch", "ChatBotAccessUpdateRequest"],
    ["/bots/{botId}/avatar", "put", "BotAvatarUploadRequest"],
    ["/bot-favorites", "patch", "BotFavoritesUpdateRequest"],
    ["/bot-access-notice/acknowledgement", "post", "BotAccessNoticeAcknowledgementRequest"],
  ] as const) {
    assert.equal(requestSchemaRef(route, method), `#/components/schemas/${schema}`);
  }
  for (const [route, method, status, schema] of [
    ["/bots", "get", "200", "BotList"],
    ["/bots", "post", "201", "BotDetail"],
    ["/bots/{botId}", "get", "200", "BotDetail"],
    ["/bots/{botId}", "patch", "200", "BotDetail"],
    ["/bots/{botId}", "delete", "200", "BotDetail"],
    ["/bots/{botId}/restore", "post", "200", "BotDetail"],
    ["/bot-conversations", "get", "200", "BotConversationPage"],
    ["/bots/{botId}/chats", "post", "201", "BotChatCreateResponse"],
    ["/bot-capabilities", "get", "200", "BotCapabilityCatalog"],
    ["/bots/{botId}/capabilities", "patch", "200", "BotAccessView"],
    ["/chats/{chatId}/capabilities", "get", "200", "ChatBotAccessView"],
    ["/chats/{chatId}/capabilities", "patch", "200", "ChatBotAccessView"],
    ["/bot-conversations/{chatId}/files", "get", "200", "FileIndex"],
    ["/bot-conversations/{chatId}/files/{fileId}", "get", "200", "FileDocument"],
    ["/bot-conversations/{chatId}/files/{fileId}", "put", "200", "FileDocument"],
    ["/bots/{botId}/avatar", "put", "200", "BotAvatarAsset"],
    ["/bots/{botId}/avatar", "delete", "200", "BotDetail"],
    ["/bot-favorites", "get", "200", "BotFavoritesView"],
    ["/bot-favorites", "patch", "200", "BotFavoritesView"],
    ["/bot-access-notice", "get", "200", "BotAccessNoticeStatus"],
    ["/bot-access-notice/acknowledgement", "post", "200", "BotAccessNoticeStatus"],
  ] as const) {
    assert.equal(responseSchemaRef(route, method, status), `#/components/schemas/${schema}`);
  }
  for (const [route, method, archivedAccess] of [
    ["/bots/{botId}", "get", "readable"],
    ["/bot-conversations", "get", "readable"],
    ["/bot-conversations/{chatId}/files/{fileId}", "get", "readable"],
    ["/bots/{botId}/avatar/{assetRevision}", "get", "readable"],
    ["/bots/{botId}", "patch", "mutation_blocked"],
    ["/bots/{botId}/chats", "post", "mutation_blocked"],
    ["/bots/{botId}/capabilities", "patch", "mutation_blocked"],
    ["/bot-conversations/{chatId}/files/{fileId}", "put", "mutation_blocked"],
    ["/bots/{botId}/avatar", "put", "mutation_blocked"],
    ["/bots/{botId}/restore", "post", "restore"],
    ["/bot-favorites", "patch", "reject_archived_additions"],
  ] as const) {
    assert.equal(
      operation(route, method)["x-aiden-archived-access"],
      archivedAccess,
      `${method} ${route}`,
    );
  }
});

test("mutation contracts require idempotency or revision preconditions", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  const paths = record(document.paths, "paths");
  const operation = (route: string, method: string) =>
    record(record(paths[route], route)[method], `${method} ${route}`);
  const parameterRefs = (route: string, method: string) =>
    ((operation(route, method).parameters as Array<Record<string, unknown>> | undefined) ?? []).map(
      (parameter) => parameter.$ref,
    );

  for (const [route, method] of [
    ["/workspaces", "post"],
    ["/chats", "post"],
    ["/chats/{chatId}/move", "post"],
    ["/chats/{chatId}/turns", "post"],
    ["/bots", "post"],
    ["/bots/{botId}/restore", "post"],
    ["/bots/{botId}/chats", "post"],
    ["/bots/{botId}/avatar", "put"],
    ["/bot-access-notice/acknowledgement", "post"],
    ["/streams/{streamId}/cancel", "post"],
    ["/approvals/{approvalId}/respond", "post"],
    ["/workspaces/{workspaceId}/git/branches", "post"],
    ["/workspaces/{workspaceId}/git/checkout", "post"],
    ["/workspaces/{workspaceId}/git/commit", "post"],
    ["/workspaces/{workspaceId}/git/push", "post"],
    ["/workspaces/{workspaceId}/git/worktrees", "post"],
    ["/workspaces/{workspaceId}/git/managed-worktree", "delete"],
    ["/scheduled-tasks", "post"],
    ["/scheduled-tasks/{taskId}/pause", "post"],
    ["/scheduled-tasks/{taskId}/resume", "post"],
    ["/scheduled-tasks/{taskId}/run", "post"],
  ] as const) {
    assert(parameterRefs(route, method).includes("#/components/parameters/IdempotencyKey"));
  }

  for (const [route, method] of [
    ["/workspaces/{workspaceId}", "patch"],
    ["/workspaces/{workspaceId}", "delete"],
    ["/chats/{chatId}", "patch"],
    ["/chats/{chatId}", "delete"],
    ["/bots/{botId}", "patch"],
    ["/bots/{botId}", "delete"],
    ["/bots/{botId}/restore", "post"],
    ["/bots/{botId}/capabilities", "patch"],
    ["/chats/{chatId}/capabilities", "patch"],
    ["/bots/{botId}/avatar", "put"],
    ["/bots/{botId}/avatar", "delete"],
    ["/bot-favorites", "patch"],
    ["/scheduled-tasks/{taskId}", "patch"],
    ["/scheduled-tasks/{taskId}", "delete"],
    ["/scheduled-tasks/settings", "patch"],
    ["/scheduled-tasks/{taskId}/pause", "post"],
    ["/scheduled-tasks/{taskId}/resume", "post"],
  ] as const) {
    assert(parameterRefs(route, method).includes("#/components/parameters/IfMatch"));
  }
});

test("wire schemas are allowlists and pairing requires pinned HTTPS identity", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  const components = record(document.components, "components");
  const schemas = record(components.schemas, "schemas");
  for (const name of [
    "Server",
    "Workspace",
    "Chat",
    "MessageAttachment",
    "FileIndex",
    "FileDocument",
    "GitResult",
    "ScheduledTask",
    "ErrorEnvelope",
  ]) {
    assert.equal(record(schemas[name], name).additionalProperties, false, `${name} must be an allowlist`);
  }
  for (const name of [
    "PairingBootstrap",
    "GitDiffRequest",
    "GitCreateBranchRequest",
    "GitCheckoutRequest",
    "GitCommitRequest",
    "GitPushRequest",
    "GitCompareRequest",
    "GitComparisonDiffRequest",
    "GitCreateWorktreeRequest",
  ]) {
    assert.equal(record(schemas[name], name).additionalProperties, false, `${name} must be an allowlist`);
  }
  const attachmentUploadVariants = record(schemas.AttachmentUpload, "AttachmentUpload").oneOf;
  assert(Array.isArray(attachmentUploadVariants));
  assert.equal(attachmentUploadVariants.length, 2);
  for (const [index, variant] of attachmentUploadVariants.entries()) {
    assert.equal(record(variant, `AttachmentUpload.oneOf[${index}]`).additionalProperties, false);
  }
  const gitProjectionVariants = record(schemas.GitProjection, "GitProjection").oneOf;
  assert(Array.isArray(gitProjectionVariants));
  assert(gitProjectionVariants.length > 0);
  for (const [index, variant] of gitProjectionVariants.entries()) {
    assert.equal(record(variant, `GitProjection.oneOf[${index}]`).additionalProperties, false);
  }
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const bootstrap = fixture.pairingBootstrap;
  const pairing = record(fixture.pairingExchange, "pairing exchange fixture");
  assert.match(bootstrap.endpoint, /^https:\/\//);
  assert.match(bootstrap.serverSpkiSha256, /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.equal(bootstrap.secret.length >= 32, true);
  assert.equal(pairing.endpoint, bootstrap.endpoint);
  assert.equal(pairing.serverSpkiSha256, bootstrap.serverSpkiSha256);
  assert.equal(record(schemas.PairingBootstrap, "PairingBootstrap").additionalProperties, false);
  const pairingBootstrapEndpointPattern = record(
    record(record(schemas.PairingBootstrap, "PairingBootstrap").properties, "PairingBootstrap properties").endpoint,
    "PairingBootstrap endpoint",
  ).pattern;
  const pairingExchangeEndpointPattern = record(
    record(record(schemas.PairingExchangeResponse, "PairingExchangeResponse").properties, "PairingExchangeResponse properties").endpoint,
    "PairingExchangeResponse endpoint",
  ).pattern;
  for (const pattern of [pairingBootstrapEndpointPattern, pairingExchangeEndpointPattern]) {
    assert.equal(typeof pattern, "string");
    const endpoint = new RegExp(pattern as string);
    for (const [authority, valid] of endpointAuthorityVectors) {
      assert.equal(
        endpoint.test(`https://${authority}${AIDEN_REMOTE_BASE_PATH}`),
        valid,
        `OpenAPI endpoint pattern disagrees for ${authority}`,
      );
    }
    assert.equal(endpoint.test("https://user:secret@aiden.example.test/api/aiden/v1"), false);
  }
  assert.deepEqual(record(schemas.WorkspacePatch, "WorkspacePatch").required, ["confirmedForeground"]);
  assert.deepEqual(record(schemas.MemorySettingsMutation, "MemorySettingsMutation").required, ["enabled", "confirmedForeground"]);
  assert.deepEqual(record(schemas.ScheduleSettingsMutation, "ScheduleSettingsMutation").required, ["confirmedForeground"]);
  const messageRoles = record(record(record(schemas.Message, "Message").properties, "Message properties").role, "Message role").enum;
  assert(Array.isArray(messageRoles));
  assert.equal(messageRoles.includes("system"), false);
  assert.equal(record(schemas.ErrorDetails, "ErrorDetails").additionalProperties, false);
  const streamEvent = record(schemas.StreamEvent, "StreamEvent");
  assert.equal(streamEvent.additionalProperties, true, "SSE envelopes must remain additively extensible");
  const streamEventVariants = streamEvent.allOf;
  assert(Array.isArray(streamEventVariants));
  const conditionalForType = (type: string) => streamEventVariants.find((variant) => {
    const condition = record(record(record(variant, "StreamEvent conditional").if, "if").properties, "if properties");
    const typeCondition = record(condition.type, "type condition");
    return typeCondition.const === type;
  });
  for (const [type, terminal] of [
    ["heartbeat", false],
    ["done", true],
    ["error", true],
    ["cancelled", true],
  ] as const) {
    const conditional = record(conditionalForType(type), `${type} conditional`);
    const thenProperties = record(record(conditional.then, `${type} then`).properties, `${type} then properties`);
    assert.equal(record(thenProperties.terminal, `${type} terminal`).const, terminal);
  }
  const unknownConditional = streamEventVariants.find((variant) => {
    const condition = record(record(record(variant, "unknown conditional").if, "if").properties, "if properties");
    const typeCondition = record(condition.type, "unknown type condition");
    return "not" in typeCondition;
  });
  const unknownThen = record(record(record(unknownConditional, "unknown conditional").then, "unknown then").properties, "unknown then properties");
  assert.equal(record(unknownThen.terminal, "unknown terminal").const, false);
  const streamStates = record(record(record(schemas.StreamStatus, "StreamStatus").properties, "StreamStatus properties").state, "StreamStatus state").enum;
  assert(Array.isArray(streamStates));
  assert(streamStates.includes("reconciling"));
  const statusConditional = record(conditionalForType("status"), "status conditional");
  const statusThenProperties = record(record(statusConditional.then, "status then").properties, "status then properties");
  const statusPayloadStates = record(record(record(statusThenProperties.payload, "status payload").properties, "status payload properties").state, "status payload state").enum;
  assert.deepEqual(statusPayloadStates, ["queued", "running", "waiting_for_approval", "reconciling"]);
  assert.deepEqual(record(schemas.ErrorCode, "ErrorCode").enum, AIDEN_REMOTE_ERROR_CODES);
  const remotePattern = record(record(record(schemas.GitPushRequest, "GitPushRequest").properties, "GitPushRequest properties").remote, "Git remote").pattern;
  assert.equal(typeof remotePattern, "string");
  const safeRemote = new RegExp(remotePattern as string);
  assert.equal(safeRemote.test("origin"), true);
  assert.equal(safeRemote.test("https://user:secret@example.test/repo.git"), false);
});

test("pairing, typed SSE payloads, and error details fail closed", async () => {
  const source = record(await json("fixtures/contract.json"), "fixture");
  const clone = () => structuredClone(source);
  const bootstrapWithExtraField = clone();
  record(bootstrapWithExtraField.pairingBootstrap, "bootstrap").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(bootstrapWithExtraField), /unsupported field/);
  const exchangeWithExtraField = clone();
  record(exchangeWithExtraField.pairingExchange, "exchange").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(exchangeWithExtraField), /unsupported field/);
  const errorEnvelopeWithExtraField = clone();
  record(errorEnvelopeWithExtraField.error, "error envelope").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(errorEnvelopeWithExtraField), /unsupported field/);
  const errorBodyWithExtraField = clone();
  record(record(errorBodyWithExtraField.error, "error envelope").error, "error").unexpected = true;
  assert.throws(() => parseAidenRemoteContractFixture(errorBodyWithExtraField), /unsupported field/);
  const errorDetailsWithExtraField = clone();
  record(record(errorDetailsWithExtraField.error, "error envelope").error, "error").details = { unexpected: true };
  assert.throws(() => parseAidenRemoteContractFixture(errorDetailsWithExtraField), /unsupported field/);

  const oversizedBootstrapInstance = clone();
  record(oversizedBootstrapInstance.pairingBootstrap, "bootstrap").instanceId = "i".repeat(129);
  assert.throws(() => parseAidenRemoteContractFixture(oversizedBootstrapInstance), /instanceId.*128/);
  const oversizedExchangeInstance = clone();
  record(oversizedExchangeInstance.pairingExchange, "exchange").instanceId = "i".repeat(129);
  assert.throws(() => parseAidenRemoteContractFixture(oversizedExchangeInstance), /instanceId.*128/);
  const oversizedDeviceId = clone();
  record(oversizedDeviceId.pairingExchange, "exchange").deviceId = "d".repeat(129);
  assert.throws(() => parseAidenRemoteContractFixture(oversizedDeviceId), /deviceId.*128/);
  const oversizedUtf8Endpoint = clone();
  record(oversizedUtf8Endpoint.pairingBootstrap, "bootstrap").endpoint =
    `https://${"é".repeat(1_020)}.test/api/aiden/v1`;
  assert.throws(() => parseAidenRemoteContractFixture(oversizedUtf8Endpoint), /UTF-8 bytes/);

  const weakSecret = clone();
  record(weakSecret.pairingBootstrap, "bootstrap").secret = "predictable-secret-that-is-long-enough";
  assert.throws(() => parseAidenRemoteContractFixture(weakSecret), /32 random bytes/);
  const wrongExchange = clone();
  record(wrongExchange.pairingExchange, "exchange").endpoint = "https://other.example.test/api/aiden/v1";
  assert.throws(() => parseAidenRemoteContractFixture(wrongExchange), /does not match bootstrap/);
  const userInfoEndpoint = clone();
  record(userInfoEndpoint.pairingBootstrap, "bootstrap").endpoint = "https://user:secret@aiden-fixture.example.test/api/aiden/v1";
  assert.throws(() => parseAidenRemoteContractFixture(userInfoEndpoint), /canonical HTTPS Aiden v1 URL/);
  for (const endpoint of [
    "https://:443/api/aiden/v1",
    "https://aiden-fixture.example.test:0/api/aiden/v1",
    "https://aiden-fixture.example.test:65536/api/aiden/v1",
    "https://aiden-fixture.example.test:abc/api/aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/v1?",
    "https://aiden-fixture.example.test/api/aiden/v1#",
    "https://aiden-fixture.example.test/api/./aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/../aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/v1/../v1",
    "https://aiden-fixture.example.test/api/aiden/v1/%2e%2e/v1",
    "https://aiden-fixture.example.test/api/aiden/v1/%2E",
    "https://aiden-fixture.example.test/%61pi/aiden/v1",
    "https://aiden-fixture.example.test/api/aiden/%76%31",
  ]) {
    const nonCanonicalPath = clone();
    record(nonCanonicalPath.pairingBootstrap, "bootstrap").endpoint = endpoint;
    assert.throws(() => parseAidenRemoteContractFixture(nonCanonicalPath), /canonical HTTPS Aiden v1 URL/);
  }
  const longLived = clone();
  record(longLived.pairingBootstrap, "bootstrap").expiresAt = "2026-08-18T19:06:00.000Z";
  assert.throws(() => parseAidenRemoteContractFixture(longLived), /five minutes/);
  const permissiveExpiry = clone();
  record(permissiveExpiry.pairingBootstrap, "bootstrap").expiresAt = "August 18, 2026 19:05:00 GMT";
  assert.throws(() => parseAidenRemoteContractFixture(permissiveExpiry), /strict RFC 3339/);
  const malformedServerTime = clone();
  record(malformedServerTime.server, "server").serverTime = "not-a-date";
  assert.throws(() => parseAidenRemoteContractFixture(malformedServerTime), /serverTime.*RFC 3339/);
  const missingServerTime = clone();
  delete record(missingServerTime.server, "server").serverTime;
  assert.throws(() => parseAidenRemoteContractFixture(missingServerTime), /serverTime.*RFC 3339/);
  for (const invalidFeature of ["Uppercase", "future:feature", `f${"x".repeat(64)}`]) {
    const malformedFeature = clone();
    record(malformedFeature.server, "server").features = ["chat-summaries-v1", invalidFeature];
    assert.throws(() => parseAidenRemoteContractFixture(malformedFeature), /server feature is invalid/);
  }
  const unknownCapability = clone();
  record(unknownCapability.pairingExchange, "exchange").capabilities = ["admin:everything"];
  assert.throws(() => parseAidenRemoteContractFixture(unknownCapability), /Unknown pairing capability/);
  const unknownServerCapability = clone();
  record(unknownServerCapability.server, "server").serverCapabilities = ["admin:everything"];
  assert.throws(
    () => parseAidenRemoteContractFixture(unknownServerCapability),
    /Unknown server-supported capability/,
  );
  const widenedDeviceGrant = clone();
  record(widenedDeviceGrant.server, "server").capabilities = ["bot:write"];
  assert.throws(
    () => parseAidenRemoteContractFixture(widenedDeviceGrant),
    /bot:write capability requires bot:read/,
  );
  const writeOnlyPairingGrant = clone();
  record(writeOnlyPairingGrant.pairingExchange, "exchange").capabilities = ["bot:write"];
  assert.throws(
    () => parseAidenRemoteContractFixture(writeOnlyPairingGrant),
    /bot:write capability requires bot:read/,
  );
  const writeOnlyServerSupport = clone();
  record(writeOnlyServerSupport.server, "server").serverCapabilities = ["bot:write"];
  assert.throws(
    () => parseAidenRemoteContractFixture(writeOnlyServerSupport),
    /bot:write capability requires bot:read/,
  );
  const unsafeDetails = clone();
  record(record(unsafeDetails.error, "error envelope").error, "error").details = { absolutePath: "/private/secret" };
  assert.throws(() => parseAidenRemoteContractFixture(unsafeDetails), /unsupported field/);
  for (const requiredField of ["message", "requestId", "retryable"]) {
    const malformed = clone();
    delete record(record(malformed.error, "error envelope").error, "error")[requiredField];
    assert.throws(() => parseAidenRemoteContractFixture(malformed));
  }
  for (const [field, value] of [
    ["retryAfterSeconds", 86_401],
    ["limit", 1_000_001],
    ["minimumClientVersion", "v".repeat(41)],
    ["field", "f".repeat(121)],
  ] as const) {
    const malformed = clone();
    record(record(malformed.error, "error envelope").error, "error").details = { [field]: value };
    assert.throws(() => parseAidenRemoteContractFixture(malformed), new RegExp(`Error detail ${field} is invalid`));
  }

  const event = record((source.events as unknown[])[0], "event");
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, payload: { ...record(event.payload, "payload"), hiddenPrompt: "secret" } }), /unsupported field/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, payload: { chatId: "chat_fixture_01" } }), /missing required field/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, payload: { chatId: "chat_fixture_01", turnId: "turn_fixture_01", nextSequence: "2" } }), /must be positive/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, protocolVersion: 2 }), /unsupported protocolVersion/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, streamId: "" }), /non-empty string/);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, sequence: 0 }), /positive/);
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, timestamp: "August 18, 2026 19:01:01 GMT" }),
    /strict RFC 3339/,
  );
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: { ignored: true } }));
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "status", payload: { state: "reconciling" } }));
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, type: "status", payload: { state: "done" } }), /status state is invalid/);
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "error", terminal: true, payload: { code: "idempotency_capacity", message: "Retry later." } }));
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "error", terminal: true, payload: { code: "idempotency_in_flight", message: "Still reconciling." } }));
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({ ...event, type: "error", terminal: true, payload: { code: "handle_capacity", message: "Browse again later." } }));
  assert.equal(parseAidenRemoteStreamEvent({ ...event, type: "future_progress", terminal: false, payload: {}, futureEnvelopeMetadata: true }), null);
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, type: "future_progress", terminal: false, payload: undefined }), /payload must be an object/);
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, type: "future_progress", terminal: false, payload: { absolutePath: "/private/secret" } }),
    /Forbidden Aiden Remote wire key/,
  );
  assert.throws(() => parseAidenRemoteStreamEvent({ ...event, type: "future_terminal", terminal: true, payload: {} }), /Unknown terminal/);
});

test("endpoint authority grammar stays exact across LAN and tailnet host forms", async () => {
  const source = record(await json("fixtures/contract.json"), "fixture");
  for (const [authority, valid] of endpointAuthorityVectors) {
    const candidate = structuredClone(source);
    const endpoint = `https://${authority}${AIDEN_REMOTE_BASE_PATH}`;
    record(candidate.pairingBootstrap, "bootstrap").endpoint = endpoint;
    if (valid) {
      record(candidate.pairingExchange, "exchange").endpoint = endpoint;
      assert.doesNotThrow(() => parseAidenRemoteContractFixture(candidate), authority);
    } else {
      assert.throws(
        () => parseAidenRemoteContractFixture(candidate),
        /canonical HTTPS Aiden v1 URL/,
        authority,
      );
    }
  }
});

test("OpenAPI and runtime stream sequence bounds stay at the JSON safe-integer maximum", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  const paths = record(document.paths, "paths");
  const streamEvents = record(paths["/streams/{streamId}/events"], "stream events");
  const get = record(streamEvents.get, "stream events get");
  const parameters = get.parameters as Array<Record<string, unknown>>;
  const parameterSchema = (name: string): Record<string, unknown> => {
    const parameter = parameters.find((candidate) => candidate.name === name);
    assert(parameter, `missing stream sequence parameter ${name}`);
    return record(parameter.schema, `${name} schema`);
  };
  for (const name of ["Last-Event-ID", "after"]) {
    assert.equal(parameterSchema(name).maximum, Number.MAX_SAFE_INTEGER, `${name} maximum`);
  }

  const schemas = record(record(document.components, "components").schemas, "schemas");
  const streamStatusProperties = record(record(schemas.StreamStatus, "StreamStatus").properties, "StreamStatus properties");
  assert.equal(record(streamStatusProperties.lastSequence, "lastSequence").maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.prototype.hasOwnProperty.call(streamStatusProperties, "approval"), false);
  const pendingApproval = record(schemas.PendingApproval, "PendingApproval");
  assert.deepEqual(pendingApproval.required, [
    "approvalId", "streamId", "chatId", "summary", "toolCallId", "toolName", "expiresAt", "canAllow",
  ]);
  const approvalSnapshot = record(schemas.StreamApprovalSnapshot, "StreamApprovalSnapshot");
  assert.deepEqual(approvalSnapshot.required, ["approval"]);
  const streamEvent = record(schemas.StreamEvent, "StreamEvent");
  const streamEventVariants = streamEvent.allOf as Array<Record<string, unknown>>;
  const streamEventBaseProperties = record(
    streamEvent.properties,
    "StreamEvent base properties",
  );
  assert.equal(record(streamEventBaseProperties.sequence, "sequence").maximum, Number.MAX_SAFE_INTEGER);
  const snapshotConditional = streamEventVariants.find((variant) => {
    const condition = record(record(variant.if, "snapshot if").properties, "snapshot if properties");
    return record(condition.type, "snapshot type").const === "snapshot";
  });
  assert(snapshotConditional, "missing snapshot conditional");
  const snapshotPayload = record(
    record(record(snapshotConditional.then, "snapshot then").properties, "snapshot then properties").payload,
    "snapshot payload",
  );
  const snapshotProperties = record(
    snapshotPayload.properties,
    "snapshot payload properties",
  );
  assert.equal(record(snapshotProperties.nextSequence, "nextSequence").maximum, Number.MAX_SAFE_INTEGER);

  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const event = record(fixture.events[0], "event");
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({
    ...event,
    sequence: Number.MAX_SAFE_INTEGER,
  }));
  assert.throws(
    () => parseAidenRemoteStreamEvent({
      ...event,
      sequence: 9007199254740992,
    }),
    /safe integer/,
  );
  assert.doesNotThrow(() => parseAidenRemoteStreamEvent({
    ...event,
    payload: {
      chatId: "chat_fixture_01",
      turnId: "turn_fixture_01",
      nextSequence: Number.MAX_SAFE_INTEGER,
    },
  }));
  assert.throws(
    () => parseAidenRemoteStreamEvent({
      ...event,
      payload: {
        chatId: "chat_fixture_01",
        turnId: "turn_fixture_01",
        nextSequence: 9007199254740992,
      },
    }),
    /positive/,
  );
});

test("JSON entry points reject non-finite values, invalid UTF-16, and unsupported object graphs", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const event = record(fixture.events[0], "event");

  for (const value of [Infinity, Number.NaN]) {
    assert.throws(
      () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: { value } }),
      /numbers must be finite/,
    );
  }
  for (const token of ["Infinity", "NaN", "1e400"]) {
    assert.throws(
      () => parseAidenSseFrames(`id: 1\ndata: ${token}\n\n`),
      /Malformed Aiden SSE JSON data/,
    );
  }

  let deepMetadata: Record<string, unknown> = {};
  for (let index = 0; index < 129; index += 1) {
    deepMetadata = { nested: deepMetadata };
  }
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: deepMetadata }),
    /maximum nesting depth/,
  );

  const tooManyKeys = Object.fromEntries(
    Array.from({ length: 16_385 }, (_, index) => [`key${index}`, index]),
  );
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: tooManyKeys }),
    /maximum object-key count/,
  );

  const cyclicMetadata: Record<string, unknown> = {};
  cyclicMetadata.self = cyclicMetadata;
  assert.throws(
    () => parseAidenRemoteStreamEvent({ ...event, futureEnvelopeMetadata: cyclicMetadata }),
    /cycles are not supported/,
  );

  for (const escape of ["\\ud800", "\\udc00"]) {
    assert.throws(
      () => parseAidenSseFrames(`id: 1\ndata: {"value":"${escape}"}\n\n`),
      /Malformed Aiden SSE JSON data/,
    );
  }
  const validPair = parseAidenSseFrames('id: 1\ndata: {"value":"\\ud83d\\ude00"}\n\n');
  assert.deepEqual(validPair[0]?.data, { value: "😀" });
  assert.throws(
    () => parseAidenSseFrames('id: 1\ndata: {"😀":1,"\\ud83d\\ude00":2}\n\n'),
    /Malformed Aiden SSE JSON data/,
  );
});

test("Chat text keeps scalar bounds, validates UTF-16 timeline offsets, and rejects lone surrogates", () => {
  const projection = {
    id: "chat-unicode",
    workspaceId: "workspace-unicode",
    title: `${"t".repeat(1_023)}😀`,
    messages: [{
      id: "message-unicode",
      role: "assistant",
      text: "😀",
      createdAt: "2026-08-23T00:00:00.000Z",
      timeline: {
        version: 3,
        generationId: "generation-unicode",
        status: "completed",
        startedAt: 1,
        finishedAt: 2,
        steps: [{
          id: "think-1",
          order: 0,
          kind: "thinking",
          startedAt: 1,
          updatedAt: 2,
          finishedAt: 2,
          contentOffset: 2,
        }],
      },
    }],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    revision: "revision-unicode",
  };

  const parsed = parseAidenRemoteChatProjection(projection);
  assert.equal(parsed.title, projection.title);
  assert.equal(parsed.messages[0]?.timeline?.steps[0]?.contentOffset, 2);

  for (const invalid of [
    { ...projection, title: "private-title-\ud800-tail" },
    {
      ...projection,
      messages: [{ ...projection.messages[0], text: "private-text-\udc00-tail" }],
    },
  ]) {
    assert.throws(() => parseAidenRemoteChatProjection(invalid), /characters/u);
  }
});

test("SSE framing resumes by id, ignores duplicates and unknown nonterminal events, and reconciles gaps", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const [first, second] = fixture.events;
  const wire = `id: ${first.sequence}\ndata: ${JSON.stringify(first)}\n\nid: ${second.sequence}\ndata: ${JSON.stringify(second)}\n\n`;
  const frames = parseAidenSseFrames(wire);
  assert.throws(
    () => parseAidenSseFrames('id: 1\ndata: {"a":1,"a":2}\n\n'),
    /Malformed Aiden SSE JSON data/,
  );
  assert.throws(
    () => parseAidenSseFrames('id: 1\ndata: {"outer":{"a":1,"\\u0061":2}}\n\n'),
    /Malformed Aiden SSE JSON data/,
  );
  assert.throws(
    () => parseAidenSseFrames(`id: 1\ndata: ${"x".repeat(AIDEN_REMOTE_MAX_SSE_FRAME_BYTES)}\n\n`),
    /exceeds the byte limit/,
  );
  assert.deepEqual(reconcileAidenSseFrames(frames, 0, first.streamId), { events: [first, second], reconcileRequired: false });
  assert.deepEqual(reconcileAidenSseFrames(frames, 1, first.streamId), { events: [second], reconcileRequired: false });
  assert.equal(reconcileAidenSseFrames([{ ...frames[1], id: "3" }], 1, first.streamId).reconcileRequired, true);
  assert.equal(reconcileAidenSseFrames([{ ...frames[1], data: { ...record(frames[1].data, "data"), sequence: 3 } }], 1, first.streamId).reconcileRequired, true);
  const future = { ...record(frames[0].data, "data"), type: "future_progress", terminal: false, payload: {} };
  assert.deepEqual(reconcileAidenSseFrames([{ id: "1", data: future }], 0, first.streamId), { events: [], reconcileRequired: false });
  const futureBetween = { ...future, sequence: 2 };
  const third = { ...second, sequence: 3 };
  assert.deepEqual(reconcileAidenSseFrames([{ id: "1", data: first }, { id: "2", data: futureBetween }, { id: "3", data: third }], 0, first.streamId), { events: [first, third], reconcileRequired: false });
  const terminal = { ...first, sequence: 1, type: "done", terminal: true, payload: { messageId: "message-terminal" } };
  const afterTerminal = { ...second, sequence: 2, type: "heartbeat", terminal: false, payload: {} };
  const terminalResult = reconcileAidenSseFrames([{ id: "1", data: terminal }, { id: "2", data: afterTerminal }], 0, first.streamId);
  assert.equal(terminalResult.reconcileRequired, true);
  assert.deepEqual(terminalResult.events.map((event) => event.type), ["done"]);
  assert.equal(
    reconcileAidenSseFrames([{ id: "1", data: { ...first, streamId: "stream_other" } }], 0, first.streamId).reconcileRequired,
    true,
  );
  assert.equal(
    reconcileAidenSseFrames([{ id: "1", data: { ...future, streamId: "stream_other" } }], 0, first.streamId).reconcileRequired,
    true,
  );
});
