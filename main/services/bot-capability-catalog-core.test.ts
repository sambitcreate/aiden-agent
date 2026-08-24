import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BOT_CAPABILITY_CATALOG_MAX_PUBLIC_BYTES,
  assertSafeBotCapabilityCatalogProjection,
  buildBotCapabilityCatalogSnapshot,
  finalizeBotCapabilityCatalog,
  type BotCapabilityInventory,
  type BotCapabilityOpaqueIdMint,
} from "./bot-capability-catalog-core.js";
import { createBotCapabilityOpaqueIdMint } from "./bot-capability-bindings.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const notice = {
  version: "bot-full-access-v1" as const,
  requiresAcknowledgement: true as const,
};

function inventory(): BotCapabilityInventory {
  return {
    providers: [
      {
        sourceId: "provider.internal.primary",
        label: "Aiden Cloud",
        available: true,
        connectionFingerprint: digest("provider-connection"),
        models: [
          {
            sourceId: "model/internal/large",
            label: "Aiden Large",
            available: true,
            modelFingerprint: digest("model-large"),
          },
          {
            sourceId: "model/internal/small",
            label: "Aiden Small",
            available: false,
            modelFingerprint: digest("model-small"),
          },
        ],
      },
    ],
    fileScopes: [
      {
        sourceId: "files.private-full",
        label: "Full Mac",
        description: "Files in locations your Mac lets Aiden access.",
        available: true,
        kind: "full_mac",
        scopeFingerprint: digest("full-file-policy"),
      },
      {
        sourceId: "files.private-home",
        label: "Bot folder",
        description: "Files in this bot's private Aiden folder.",
        available: true,
        kind: "bot_home",
        scopeFingerprint: digest("bot-home-policy"),
      },
      {
        sourceId: "root.internal.documents",
        label: "Documents",
        available: true,
        kind: "approved_location",
        scopeFingerprint: digest("private-root-device-inode-and-policy"),
      },
    ],
    shell: {
      available: true,
      shellFingerprint: digest("shell-policy"),
    },
    connections: [
      {
        sourceId: "mcp.internal.calendar",
        label: "Calendar",
        description: "Use the configured Calendar connection.",
        available: true,
        connectionFingerprint: digest("mcp-config-and-credential-revision"),
        tools: [
          {
            name: "list_events",
            inputSchemaFingerprint: digest("list-input-schema"),
            outputSchemaFingerprint: digest("list-output-schema"),
            effect: "read",
            effectFingerprint: digest("read-effect"),
          },
          {
            name: "create_event",
            inputSchemaFingerprint: digest("create-input-schema"),
            outputSchemaFingerprint: digest("create-output-schema"),
            effect: "mutating",
            effectFingerprint: digest("conservative-mutation-effect"),
          },
        ],
      },
    ],
    skills: [
      {
        sourceId: "skill.stable.research",
        label: "Research brief",
        description: "Prepare a concise research brief.",
        available: true,
        identityFingerprint: digest("skill-identity-without-path"),
        contentFingerprint: digest("exact-private-skill-content"),
      },
    ],
    otherCapabilities: [
      {
        kind: "web",
        label: "Web",
        description: "Find current public information online.",
        available: true,
        capabilityFingerprint: digest("web-runtime-policy"),
      },
      {
        kind: "computer_use",
        label: "Computer Use",
        available: false,
        capabilityFingerprint: digest("computer-use-runtime-policy"),
      },
    ],
  };
}

const key = Buffer.alloc(32, 7);

function snapshot(value = inventory()) {
  return buildBotCapabilityCatalogSnapshot({
    inventory: value,
    notice,
    mintOpaqueId: createBotCapabilityOpaqueIdMint(key),
  });
}

test("catalog projects only bounded public data and includes explicit Full Mac", () => {
  const result = snapshot();
  assert.equal(result.catalog.fileScopes[0]?.kind, "full_mac");
  assert.equal(result.catalog.fileScopes[1]?.kind, "bot_home");
  assert(result.catalog.fileScopes.some(({ kind }) => kind === "approved_location"));
  assert.match(result.catalog.revision, /^bot_catalog_[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => assertSafeBotCapabilityCatalogProjection(result.catalog));
  const publicJson = JSON.stringify(result.catalog);
  for (const privateValue of [
    "provider.internal.primary",
    "model/internal/large",
    "mcp.internal.calendar",
    "root.internal.documents",
    "skill.stable.research",
    digest("exact-private-skill-content"),
    "create_event",
  ]) {
    assert.equal(publicJson.includes(privateValue), false, privateValue);
  }
  for (const forbiddenKey of ["fingerprint", "path", "credential", "tools"] as const) {
    assert.equal(new RegExp(`"${forbiddenKey}"`, "iu").test(publicJson), false);
  }
});

test("catalog revision and opaque ids are deterministic independent of inventory ordering", () => {
  const first = snapshot();
  const reordered = inventory();
  reordered.providers[0]!.models.reverse();
  reordered.fileScopes.reverse();
  reordered.otherCapabilities.reverse();
  const second = snapshot(reordered);
  assert.deepEqual(second.catalog, first.catalog);

  const accepted = buildBotCapabilityCatalogSnapshot({
    inventory: reordered,
    notice: {
      version: "bot-full-access-v1",
      requiresAcknowledgement: false,
      acceptedAt: "2026-08-23T14:00:00.000Z",
      acceptedDecision: "continue_full",
    },
    mintOpaqueId: createBotCapabilityOpaqueIdMint(key),
  });
  assert.equal(accepted.catalog.revision, first.catalog.revision);
  assert.notDeepEqual(accepted.catalog.notice, first.catalog.notice);
});

test("MCP opaque binding changes on connection, tool schema, or effect drift", () => {
  const baseline = snapshot();
  const baselineConnection = baseline.resources.connections[0]!;
  assert.equal(baselineConnection.tools.length, 2);
  assert.match(baselineConnection.tools[0]!.exactFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(baselineConnection.toolsetFingerprint, /^[a-f0-9]{64}$/u);

  const mutations: Array<(value: BotCapabilityInventory) => void> = [
    (value) => {
      value.connections[0]!.connectionFingerprint = digest("new-credential-revision");
    },
    (value) => {
      value.connections[0]!.tools[0]!.inputSchemaFingerprint = digest("new-input-schema");
    },
    (value) => {
      value.connections[0]!.tools[0]!.outputSchemaFingerprint = digest("new-output-schema");
    },
    (value) => {
      value.connections[0]!.tools[0]!.effectFingerprint = digest("new-effect-profile");
    },
    (value) => {
      value.connections[0]!.tools[0]!.effect = "mutating";
    },
  ];
  for (const mutate of mutations) {
    const changed = inventory();
    mutate(changed);
    assert.notEqual(
      snapshot(changed).catalog.connections[0]!.id,
      baseline.catalog.connections[0]!.id,
    );
  }
});

test("skill grants bind identity and content without projecting content or paths", () => {
  const baseline = snapshot();
  const changed = inventory();
  changed.skills[0]!.contentFingerprint = digest("changed-private-skill-content");
  const drifted = snapshot(changed);
  assert.notEqual(drifted.catalog.skills[0]!.id, baseline.catalog.skills[0]!.id);
  assert.equal(JSON.stringify(drifted.catalog).includes("changed-private-skill-content"), false);

  const withPath = inventory() as unknown as {
    skills: Array<Record<string, unknown>>;
  };
  withPath.skills[0]!.path = "/Users/private/.agents/research/SKILL.md";
  assert.throws(
    () => snapshot(withPath as unknown as BotCapabilityInventory),
    /unsafe or unexpected field/u,
  );
});

test("catalog fails closed on duplicates, invalid effects, missing required file modes, and opaque collisions", () => {
  const duplicate = inventory();
  duplicate.connections.push(structuredClone(duplicate.connections[0]!));
  assert.throws(() => snapshot(duplicate), /duplicate identities/u);

  const duplicateTools = inventory();
  duplicateTools.connections[0]!.tools.push(
    structuredClone(duplicateTools.connections[0]!.tools[0]!),
  );
  assert.throws(() => snapshot(duplicateTools), /duplicate identities/u);

  const invalidEffect = inventory();
  (invalidEffect.connections[0]!.tools[0] as { effect: string }).effect = "unknown";
  assert.throws(() => snapshot(invalidEffect), /tool 0 is invalid/u);

  const missingFullMac = inventory();
  missingFullMac.fileScopes = missingFullMac.fileScopes.filter(({ kind }) => kind !== "full_mac");
  assert.throws(() => snapshot(missingFullMac), /exactly one Full Mac/u);

  const collisionMint: BotCapabilityOpaqueIdMint = () => "constant_id";
  assert.throws(
    () =>
      buildBotCapabilityCatalogSnapshot({
        inventory: inventory(),
        notice,
        mintOpaqueId: collisionMint,
      }),
    /duplicate/u,
  );
});

test("catalog rejects private-looking fields, path-like display copy, malformed fingerprints, and sparse arrays", () => {
  const privateField = inventory() as unknown as Record<string, unknown>;
  privateField.credentials = "do-not-project";
  assert.throws(
    () => snapshot(privateField as unknown as BotCapabilityInventory),
    /unsafe or unexpected field/u,
  );

  const pathLabel = inventory();
  pathLabel.skills[0]!.description = "Loaded from /Users/alice/private/SKILL.md";
  assert.throws(() => snapshot(pathLabel), /cannot be projected safely/u);

  const malformed = inventory();
  malformed.providers[0]!.connectionFingerprint = "not-a-digest";
  assert.throws(() => snapshot(malformed), /exact SHA-256 digest/u);

  const sparse = inventory();
  sparse.skills = new Array(1);
  assert.throws(() => snapshot(sparse), /sparse or unsafe entry/u);
});

test("catalog enforces provider/model aggregate limits", () => {
  const oversized = inventory();
  oversized.providers = Array.from({ length: 3 }, (_unused, providerIndex) => ({
    sourceId: `provider-${providerIndex}`,
    label: `Provider ${providerIndex}`,
    available: true,
    connectionFingerprint: digest(`provider-${providerIndex}`),
    models: Array.from({ length: 256 }, (_model, modelIndex) => ({
      sourceId: `model-${providerIndex}-${modelIndex}`,
      label: `Model ${providerIndex}-${modelIndex}`,
      available: true,
      modelFingerprint: digest(`model-${providerIndex}-${modelIndex}`),
    })),
  }));
  assert.throws(() => snapshot(oversized), /aggregate model limit/u);
});

test("public catalog enforces its aggregate UTF-8 byte ceiling", () => {
  const emojiLabel = "😀".repeat(120);
  const emojiModelLabel = "😀".repeat(160);
  const emojiDescription = "😀".repeat(280);
  const providers = Array.from({ length: 64 }, (_unused, providerIndex) => ({
    id: `provider_${providerIndex}`,
    label: emojiLabel,
    available: true,
    models: Array.from({ length: 8 }, (_model, modelIndex) => ({
      id: `model_${providerIndex}_${modelIndex}`,
      label: emojiModelLabel,
      available: true,
      supportsImages: false,
    })),
  }));
  const options = (count: number, prefix: string) =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `${prefix}_${index}`,
      label: emojiLabel,
      available: true,
      description: emojiDescription,
    }));
  const fileScopes = options(64, "file").map((option, index) => ({
    ...option,
    kind:
      index === 0
        ? ("full_mac" as const)
        : index === 1
          ? ("bot_home" as const)
          : ("approved_location" as const),
  }));
  assert.throws(
    () =>
      finalizeBotCapabilityCatalog({
        providers,
        fileScopes,
        shellAvailable: true,
        connections: options(128, "connection"),
        skills: options(256, "skill"),
        otherCapabilities: options(128, "other"),
        notice,
      }),
    /safe public byte limit/u,
  );
  assert.equal(BOT_CAPABILITY_CATALOG_MAX_PUBLIC_BYTES, 900 * 1024);
});

test("projection guard rejects a private key before serialization", () => {
  const catalog = structuredClone(snapshot().catalog) as unknown as Record<string, unknown>;
  (catalog.skills as Array<Record<string, unknown>>)[0]!.providerFingerprint = digest("leak");
  assert.throws(
    () => assertSafeBotCapabilityCatalogProjection(catalog),
    /private main-process data/u,
  );
});
