import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { BOT_AVATAR_COLORS, BOT_AVATAR_COLOR_HEX, BOT_AVATAR_FACE_HEX } from "../../renderer/shared/bots.js";
import { parseGenerationTimeline } from "../../renderer/shared/generation-timeline.js";
import { BOT_ACTIVITY_PHASES, botActivityDisplay, botElapsedLabel } from "../../renderer/shared/bot-activity.js";
import {
  parseAidenRemoteBotSession,
  parseAidenRemoteBotSessionActivity,
  parseAidenRemoteBotDetail,
  parseAidenRemoteBotIdentityPatchRequest,
  parseAidenRemoteBotMessageRequest,
  parseAidenRemoteBotSessionEntry,
  parseAidenRemoteBotSessionEvent,
  parseAidenRemoteBotSummary,
  parseAidenRemoteBotHandoff,
  parseAidenRemoteBotHandoffAnswerRequest,
  parseAidenRemoteBotHandoffOpenOnMacReceipt,
  AIDEN_REMOTE_BASE_PATH,
  AIDEN_REMOTE_BOT_AVATAR_COLOR_VALUES,
  AIDEN_REMOTE_CAPABILITIES,
  AIDEN_REMOTE_CONTRACT_REVISION,
  AIDEN_REMOTE_SIMULATOR_CAPABILITIES,
  AIDEN_REMOTE_MOBILE_SIMULATOR_CAPABILITIES,
  AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES,
  AIDEN_REMOTE_BOT_HANDOFFS_CONTRACT_REVISION,
  AIDEN_REMOTE_HOST_CAPABILITIES,
  AIDEN_REMOTE_NEGOTIABLE_CAPABILITIES,
  AIDEN_REMOTE_HOST_FEED_EVENT_TYPES,
  AIDEN_REMOTE_RUN_EVENT_TYPES,
  AIDEN_REMOTE_RUN_STATES,
  AIDEN_REMOTE_CHAT_MAX_PREVIOUS_TURNS,
  AIDEN_REMOTE_ERROR_CODES,
  AIDEN_REMOTE_EVENT_TYPES,
  AIDEN_REMOTE_MAX_CHAT_MESSAGES,
  AIDEN_REMOTE_MAX_JSON_RESPONSE_BYTES,
  AIDEN_REMOTE_MAX_SERVER_FEATURE_LENGTH,
  AIDEN_REMOTE_MAX_SERVER_FEATURES,
  AIDEN_REMOTE_MAX_SSE_FRAME_BYTES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  type AidenRemoteCapability,
  parseAidenRemoteChatAgentRoster,
  parseAidenRemoteChatTaskProgress,
  parseAidenRemoteChatProjection,
  parseAidenRemoteStreamEvent,
  parseAidenSseFrames,
  reconcileAidenSseFrames,
  parseAidenRemoteContractFixture,
  parseAidenRemoteStreamInputRequest,
  parseAidenRemoteStreamInputResult,
  parseAidenRemoteChatForkResult,
  parseAidenRemoteChatSummaryProjection,
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

// Simulator control is a desktop-to-desktop grant that pairing never issues,
// and the phone simulator viewer grant and the Bot card, activity and hand-off
// opt-ins are negotiated only after pairing.
const PAIRING_CAPABILITIES = AIDEN_REMOTE_CAPABILITIES.filter(
  (capability) =>
    !(AIDEN_REMOTE_SIMULATOR_CAPABILITIES as readonly string[]).includes(capability) &&
    !(AIDEN_REMOTE_MOBILE_SIMULATOR_CAPABILITIES as readonly string[]).includes(capability) &&
    !(AIDEN_REMOTE_BOT_OPT_IN_CAPABILITIES as readonly string[]).includes(capability),
);
// Host-wide grants are issued to desktops only, so phones are never told they
// exist either and the shared mobile fixture omits both families.
const MOBILE_CAPABILITIES = PAIRING_CAPABILITIES.filter(
  (capability) => !(AIDEN_REMOTE_HOST_CAPABILITIES as readonly string[]).includes(capability),
);

test("shared Aiden Remote v1 fixture is complete, ordered, and contains no unsafe wire keys", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  // The shared fixture tracks the host's revision; the number lives only in the protocol module.
  assert.equal(fixture.contractRevision, AIDEN_REMOTE_CONTRACT_REVISION);
  assert.match(JSON.stringify(fixture.events), /"producedFile":\{"relativePath":"out\/report.txt","operation":"written","bytes":12\}/u);
  const fixtureTimeline = fixture.events.find((event) => event.type === "timeline");
  const parsedTimeline = parseGenerationTimeline(record(fixtureTimeline?.payload, "timeline payload").timeline);
  const recapStep = parsedTimeline?.steps.find((step) => step.kind === "tool" && step.questionnaire);
  assert.ok(recapStep?.kind === "tool", "the fixture timeline carries a questionnaire recap");
  assert.equal(recapStep.toolName, "ask_user_question");
  assert.equal(recapStep.status, "completed");
  assert.equal(recapStep.questionnaire?.outcome, "answered");
  assert.deepEqual(recapStep.questionnaire?.items.map((item) => [item.kind, item.answers]), [["option", ["Plain text"]], ["skipped", []]]);
  const extractStep = parsedTimeline?.steps.find((step) => step.kind === "tool" && step.extraction);
  assert.ok(extractStep?.kind === "tool", "the fixture timeline carries a web page extract recap");
  assert.equal(extractStep.toolName, "web_fetch");
  assert.deepEqual(extractStep.extraction?.fields.map((field) => [field.name, field.status]), [["pro_monthly", "extracted"], ["team_yearly", "uncertain"], ["enterprise", "null"]]);
  assert.equal(fixture.protocolVersion, AIDEN_REMOTE_PROTOCOL_VERSION);
  assert.deepEqual(fixture.capabilities, MOBILE_CAPABILITIES);
  assert.deepEqual(fixture.server.serverCapabilities, MOBILE_CAPABILITIES);
  assert.deepEqual(fixture.server.capabilities, fixture.pairingExchange.capabilities);
  assert.equal(record(fixture.chat, "fixture chat").botId, "bot_fixture_01");
  assert.equal(fixture.server.features.includes("chat-run-input-v1"), true);
  assert.equal(fixture.server.features.includes("speech-request-gzip-v1"), true);
  assert.deepEqual(fixture.streamInput.request, { mode: "queue", text: "Also add a regression test." });
  assert.equal(fixture.streamInput.response.status, "admitted");
  assert.equal(fixture.streamInput.response.queue, "follow-up");
  assert.equal(fixture.streamInput.response.committed, true);
  assert.equal(record(fixture.speechStatus, "fixture speech status").selectedModelId, "parakeet-v3");
  assert.equal(record(fixture.speechTranscription, "fixture speech transcription").modelId, "parakeet-v3");
  assert.equal(
    fixture.botCapabilityCatalog.fileScopes.some((scope) => scope.kind === "full_mac"),
    true,
  );
  assert.deepEqual(
    new Set(fixture.events.map((event) => event.type)),
    new Set(
      AIDEN_REMOTE_EVENT_TYPES.filter(
        (type) => type !== "task_update" && type !== "agents_update" && type !== "app_controls_changed",
      ),
    ),
  );
  assert.deepEqual(
    new Set(fixture.chatProgressEvents.map((event) => event.type)),
    new Set(["task_update", "agents_update", "app_controls_changed"]),
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

test("task progress projections reject multiple active tasks and dependency cycles", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const multipleActive = structuredClone(fixture.taskProgress);
  multipleActive.tasks[2]!.status = "in_progress";
  assert.throws(
    () => parseAidenRemoteChatTaskProgress(multipleActive),
    /at most one in_progress task/u,
  );

  const cycle = structuredClone(fixture.taskProgress);
  cycle.tasks[0]!.blockedBy = [3];
  assert.throws(
    () => parseAidenRemoteChatTaskProgress(cycle),
    /blockedBy relationships must be acyclic/u,
  );
});

test("agent interrupt fixture stops one current-turn agent and rejects rosters that do not", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, unknown>;
  const fixture = parseAidenRemoteContractFixture(raw);
  assert.equal(fixture.server.features.includes("chat-agent-interrupt-v1"), true);
  const stopped = fixture.agentInterrupt.response.agents.find(
    (agent) => agent.agentId === fixture.agentInterrupt.agentId,
  );
  assert.equal(stopped?.state, "stopped");
  assert.equal(typeof stopped?.finishedAt, "string");
  assert.equal(fixture.agentInterrupt.response.turnId, fixture.agentRoster.turnId);

  const stillRunning = structuredClone(raw);
  const interrupt = record(stillRunning.agentInterrupt, "agentInterrupt");
  const agents = record(interrupt.response, "response").agents as Record<string, unknown>[];
  agents[0]!.state = "running";
  delete agents[0]!.finishedAt;
  assert.throws(() => parseAidenRemoteContractFixture(stillRunning), /must stop an agent/u);

  const unknownAgent = structuredClone(raw);
  record(unknownAgent.agentInterrupt, "agentInterrupt").agentId = "agent_fixture_missing";
  assert.throws(() => parseAidenRemoteContractFixture(unknownAgent), /must stop an agent/u);

  const unadvertised = structuredClone(raw);
  const server = record(unadvertised.server, "server");
  server.features = (server.features as string[]).filter((feature) => feature !== "chat-agent-interrupt-v1");
  assert.throws(() => parseAidenRemoteContractFixture(unadvertised), /chat agent interrupt/u);
});

test("revision 19 fixtures carry host health, host feed, run stream and run control shapes that fail closed", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, unknown>;
  const fixture = parseAidenRemoteContractFixture(raw);
  assert.equal(fixture.hostHealth?.instanceId, fixture.pairingBootstrap.instanceId);
  assert.equal(fixture.hostHealth?.contractRevision, fixture.contractRevision);
  assert.equal(fixture.hostFeedEvents?.[0]?.type, "snapshot");
  const runEvents = fixture.runEvents ?? [];
  const ended = runEvents[runEvents.length - 1];
  assert.equal(ended?.type, "run.ended");
  assert.equal(ended?.terminal, true);
  // run.ended reuses the last content sequence so a resumed cursor stays valid.
  assert.equal(ended?.sequence, runEvents[runEvents.length - 2]?.sequence);
  assert.equal(fixture.runControlError?.error.code, "approval_resolved");
  assert.equal(fixture.runControlError?.error.details?.decision, "deny");
  // Phones keep their mobile-only grants: the shared fixture never offers host grants.
  for (const capability of AIDEN_REMOTE_HOST_CAPABILITIES) {
    assert.equal(fixture.capabilities.includes(capability), false, capability);
  }

  const mutate = (change: (copy: Record<string, unknown>) => void) => {
    const copy = structuredClone(raw);
    change(copy);
    return () => parseAidenRemoteContractFixture(copy);
  };
  const snapshotWorkspace = (copy: Record<string, unknown>) => {
    const events = copy.hostFeedEvents as Record<string, unknown>[];
    const payload = record(events[0]!.payload, "snapshot payload");
    return (payload.workspaces as Record<string, unknown>[])[0]!;
  };
  assert.throws(
    mutate((copy) => {
      snapshotWorkspace(copy).repository = {
        canonicalKey: "https://user:token@github.com/example/aiden-fixture",
        relativePath: "",
      };
    }),
    /credential-free/u,
  );
  assert.throws(
    mutate((copy) => {
      snapshotWorkspace(copy).repository = { canonicalKey: "github.com/example/aiden-fixture", relativePath: "../escape" };
    }),
    /inside the repository/u,
  );
  assert.throws(
    mutate((copy) => {
      record(copy.hostHealth, "hostHealth").instanceId = "instance_other";
    }),
    /another instance/u,
  );
  assert.throws(
    mutate((copy) => {
      record(copy.hostHealth, "hostHealth").secret = "x";
    }),
    /unsupported field/u,
  );
  assert.throws(
    mutate((copy) => {
      (copy.hostFeedEvents as unknown[]).splice(1, 1);
    }),
    /one sequence at a time/u,
  );
  assert.throws(
    mutate((copy) => {
      const events = copy.runEvents as Record<string, unknown>[];
      events.push(structuredClone(events[events.length - 1]!));
    }),
    /after run\.ended/u,
  );
  assert.throws(
    mutate((copy) => {
      const error = record(record(copy.runControlError, "runControlError").error, "error");
      record(error.details, "details").decision = "maybe";
    }),
    /decision is invalid/u,
  );

  // Revision 23: the messages window carries the chat's metadata, held to the chat projection's rules.
  assert.equal(fixture.messagesWindow?.title, "Fixture review chat");
  assert.equal(fixture.messagesWindow?.modelId, "model_fixture");
  const window = (copy: Record<string, unknown>) => record(copy.messagesWindow, "messagesWindow");
  assert.throws(mutate((copy) => { delete window(copy).title; }));
  assert.throws(mutate((copy) => { delete window(copy).modelId; }));
  assert.throws(mutate((copy) => { window(copy).updatedAt = "2026-08-18T18:00:00.000Z"; }));
  // A revision-22 window predates the metadata, so it may not carry it.
  assert.throws(
    mutate((copy) => {
      copy.contractRevision = 22;
      record(copy.hostHealth, "hostHealth").contractRevision = 22;
    }),
    /unsupported field/u,
  );
});

test("pairing request fixtures only carry a sealed envelope for an approved request and fail closed", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, unknown>;
  const fixture = parseAidenRemoteContractFixture(raw);
  const section = fixture.pairingRequests;
  assert.ok(section);
  assert.equal(section.feature, "pairing-requests-v1");
  assert.deepEqual(
    section.status.map((status) => [status.state, status.envelope !== undefined]),
    [["pending", false], ["approved", true], ["denied", false]],
  );
  assert.ok(section.matchCodeVectors.every((vector) => /^[0-9]{6}$/u.test(vector.matchCode)));

  const mutate = (change: (copy: Record<string, unknown>) => void) => {
    const copy = structuredClone(raw);
    change(copy.pairingRequests as Record<string, unknown>);
    return () => parseAidenRemoteContractFixture(copy);
  };
  const statuses = (copy: Record<string, unknown>) => copy.status as Record<string, unknown>[];
  assert.throws(
    mutate((copy) => {
      statuses(copy)[2]!.envelope = structuredClone(statuses(copy)[1]!.envelope);
    }),
    /Only an approved pairing request carries an envelope/u,
  );
  assert.throws(
    mutate((copy) => {
      delete statuses(copy)[1]!.envelope;
    }),
    /Only an approved pairing request carries an envelope/u,
  );
  assert.throws(
    mutate((copy) => {
      record(statuses(copy)[1]!.envelope, "envelope").requestId = "pairreq_BgsQFRofJCkuMzg9QkdMUVZbYGVqb3R5";
    }),
    /bound to its request/u,
  );
  assert.throws(
    mutate((copy) => {
      record(record(copy.create, "create").request, "request").deviceType = "iphone";
    }),
    /only from mac or linux/u,
  );
  assert.throws(
    mutate((copy) => {
      record(record(copy.create, "create").response, "response").credential = "secret";
    }),
    /unsupported field credential/u,
  );
  assert.throws(
    mutate((copy) => {
      (copy.matchCodeVectors as Record<string, unknown>[])[0]!.matchCode = "48334";
    }),
    /six digits/u,
  );
  assert.throws(
    mutate((copy) => {
      record(record(copy.reveal, "reveal").response, "response").hostNonce = "short";
    }),
    /32 bytes of unpadded base64url/u,
  );

  // Pairing requests arrived in revision 20: a revision-19 fixture still
  // parses without the section and is refused with it.
  const revision19 = structuredClone(raw);
  delete revision19.phoneRunEvents;
  delete revision19.peerRouteAdvertisement;
  delete revision19.mobileSimulators;
  revision19.contractRevision = 19;
  record(revision19.hostHealth, "hostHealth").contractRevision = 19;
  // The messages window's metadata is revision 23, so the older fixture omits it.
  const { chatId, revision, messages, hasOlder } = record(revision19.messagesWindow, "messagesWindow");
  revision19.messagesWindow = { chatId, revision, messages, hasOlder };
  delete revision19.chatFork;
  // Bot chat activity is revision 30.
  delete revision19.botActivity;
  delete revision19.botActivityPrivacy;
  // Bot message attachments are revision 33.
  delete revision19.botAttachments;
  // Bot hand-offs and pause are revision 37.
  delete revision19.botHandoffs;
  // Message visuals are revision 28.
  for (const message of record(revision19.chat, "chat").messages as Record<string, unknown>[]) delete message.visuals;
  assert.throws(() => parseAidenRemoteContractFixture(revision19), /require contract revision 20/u);
  delete revision19.pairingRequests;
  assert.equal(parseAidenRemoteContractFixture(revision19).pairingRequests, undefined);
});

test("phone run fixtures carry the phone approval projection and arrive in revision 24", async () => {
  const raw = await json("fixtures/contract.json");
  const fixture = parseAidenRemoteContractFixture(raw);
  const approvals = (fixture.phoneRunEvents ?? [])
    .filter((event) => event.type === "approval_required")
    .map((event) => event.payload as Record<string, unknown>);
  assert.deepEqual(approvals.map((approval) => approval.canAllow), [true, false]);
  for (const approval of approvals) {
    assert.equal("details" in approval, false);
    assert.equal("detailsOmitted" in approval, false);
  }

  const mutate = (change: (copy: Record<string, unknown>) => void) => () => {
    const copy = structuredClone(raw) as Record<string, unknown>;
    change(copy);
    return parseAidenRemoteContractFixture(copy);
  };
  const phoneApproval = (copy: Record<string, unknown>) =>
    (copy.phoneRunEvents as Array<{ type: string; payload: Record<string, unknown> }>)
      .filter((event) => event.type === "approval_required");
  assert.throws(
    mutate((copy) => {
      phoneApproval(copy)[0]!.payload.details = { kind: "scheduled-task" };
    }),
    /unsupported field details/u,
  );
  assert.throws(
    mutate((copy) => {
      phoneApproval(copy)[1]!.payload.scopes = ["once", "always"];
    }),
    /deny-only phone run approval offers no scopes/u,
  );
  assert.throws(
    mutate((copy) => {
      copy.contractRevision = 23;
      (copy.hostHealth as Record<string, unknown>).contractRevision = 23;
    }),
    /require contract revision 24/u,
  );
});

test("agent roster historical turn selectors are bounded, newest-first, and current-turn-free", async () => {
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const roster = fixture.agentRoster;
  assert.deepEqual(roster.previousTurns?.map((turn) => turn.turnId), [
    "turn_fixture_previous_02",
    "turn_fixture_previous_01",
  ]);

  const currentTurn = structuredClone(roster);
  currentTurn.previousTurns![0]!.turnId = roster.turnId!;
  assert.throws(
    () => parseAidenRemoteChatAgentRoster(currentTurn),
    /exclude the current turn/u,
  );

  const unordered = structuredClone(roster);
  [unordered.previousTurns![0], unordered.previousTurns![1]] = [
    unordered.previousTurns![1]!,
    unordered.previousTurns![0]!,
  ];
  assert.throws(
    () => parseAidenRemoteChatAgentRoster(unordered),
    /newest-first/u,
  );

  const tooMany = structuredClone(roster);
  tooMany.previousTurns = Array.from({ length: AIDEN_REMOTE_CHAT_MAX_PREVIOUS_TURNS + 1 }, (_, index) => ({
    turnId: `turn_previous_${index}`,
    startedAt: "2026-08-18T18:00:00.000Z",
  }));
  assert.throws(
    () => parseAidenRemoteChatAgentRoster(tooMany),
    /bounded array/u,
  );
});

test("OpenAPI freezes every planned route under authenticated Aiden v1 semantics", async () => {
  const document = record(await json("openapi.json"), "OpenAPI");
  assert.equal(document.openapi, "3.1.0");
  const info = record(document.info, "OpenAPI info");
  assert.equal(info.version, "1.0.0");
  const paths = record(document.paths, "OpenAPI paths");
  const requiredPaths = [
    "/providers",
    "/health",
    "/pairing/manual-bootstrap",
    "/pairing/exchange",
    "/server",
    "/device/identity",
    "/device/capabilities",
    "/workspaces",
    "/workspaces/{workspaceId}",
    "/workspace-browser/roots",
    "/workspace-browser/children",
    "/workspace-browser/selections",
    "/chat-summaries",
    "/chats",
    "/chats/{chatId}",
    "/chats/{chatId}/read",
    "/chats/{chatId}/move",
    "/chats/{chatId}/fork",
    "/chats/{chatId}/fork-summary/{action}",
    "/chats/{chatId}/tasks",
    "/chats/{chatId}/agents",
    "/chats/{chatId}/agents/{agentId}/interrupt",
    "/chats/{chatId}/skills",
    "/chats/{chatId}/progress/events",
    "/chats/{chatId}/turns",
    "/chats/{chatId}/attachments",
    "/chats/{chatId}/attachments/{attachmentId}",
    "/chats/{chatId}/attachments/{attachmentId}/content",
    "/chats/{chatId}/visuals/{visualId}/document",
    "/bots",
    "/bots/{botId}",
    "/bot-presets",
    "/bots/from-preset",
    "/bots/{botId}/session",
    "/bots/{botId}/session/events",
    "/bots/{botId}/messages",
    "/bots/{botId}/attachments",
    "/bots/{botId}/attachments/{attachmentId}",
    "/bots/{botId}/resume",
    "/bots/{botId}/dismiss",
    "/bots/{botId}/stop",
    "/bots/{botId}/questions/{waitId}/answer",
    "/bots/{botId}/handoffs/{waitId}/answer",
    "/bots/{botId}/handoffs/{waitId}/open-on-mac",
    "/bots/{botId}/pause",
    "/bots/{botId}/routines",
    "/bots/{botId}/routines/{routineId}",
    "/bots/{botId}/connection-requests",
    "/bots/{botId}/memory",
    "/bots/{botId}/memory/edits",
    "/bots/{botId}/routine-proposals/{proposalId}/respond",
    "/bots/{botId}/routine-suggestions",
    "/bots/routine-notifications",
    "/bot-conversations",
    "/bots/{botId}/chats",
    "/bot-capabilities",
    "/bots/{botId}/capabilities",
    "/bot-conversations/{chatId}/files",
    "/bot-conversations/{chatId}/files/{fileId}",
    "/bots/{botId}/avatar",
    "/bots/{botId}/avatar/{assetRevision}",
    "/streams/{streamId}",
    "/streams/{streamId}/events",
    "/streams/{streamId}/approval",
    "/streams/{streamId}/question",
    "/streams/{streamId}/cancel",
    "/streams/{streamId}/inputs",
    "/approvals/{approvalId}/respond",
    "/questions/{promptId}/respond",
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
    "/scheduled-tasks/notifications",
    "/scheduled-tasks/preview",
    "/scheduled-tasks/scripts",
    "/scheduled-tasks/mcp-servers",
    "/memory/settings",
    "/scheduled-tasks/settings",
    "/simulators",
    "/simulators/open",
    "/simulators/shutdown",
    "/simulators/settings",
    "/simulators/action",
    "/simulators/hub/{hubPath}",
    "/read-aloud",
    "/chats/{chatId}/read-aloud",
    "/chats/{chatId}/read-aloud/stop",
    "/chats/{chatId}/read-aloud/audio/{jobId}/{segment}/{offset}",
    "/host/events",
    "/chats/{chatId}/messages",
    "/chats/{chatId}/runs/current/events",
    "/runs/{runId}/events",
    "/runs/{runId}/cancel",
    "/runs/{runId}/approvals/{approvalId}/respond",
    "/runs/{runId}/questions/{promptId}/respond",
    "/runs/{runId}/inputs",
    "/pairing/requests",
    "/pairing/requests/{requestId}/reveal",
    "/pairing/requests/{requestId}",
    "/chats/{chatId}/controls/{panelId}",
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
  assert.deepEqual(record(pairingRequestProperties.deviceType, "deviceType").enum, ["iphone", "ipad", "android", "mac", "linux"]);
  assert.deepEqual(record(pairingRequestProperties.acceptsBotCapabilities, "acceptsBotCapabilities"), {
    type: "boolean",
    description: "Explicitly accepts the Bot capability vocabulary and the additive serverCapabilities projection. Bot grants are never issued when this field is absent or false.",
  });
  assert.equal(record(pairingRequestProperties.acceptsProgressCapabilities, "acceptsProgressCapabilities").type, "boolean");
  const pairingResponseCapabilities = record(
    record(
      record(schemas.PairingExchangeResponse, "PairingExchangeResponse").properties,
      "PairingExchangeResponse properties",
    ).capabilities,
    "PairingExchangeResponse capabilities",
  );
  assert.deepEqual(record(pairingResponseCapabilities.items, "pairing capability items").enum, PAIRING_CAPABILITIES);
  assert.deepEqual(
    record(
      record(
        record(record(schemas.DeviceCapabilitiesUpdateRequest, "update request").properties, "update request properties")
          .accepts,
        "accepts",
      ).items,
      "accepts items",
    ).enum,
    AIDEN_REMOTE_NEGOTIABLE_CAPABILITIES,
  );
  // Revision 19 vocabularies: the documented SSE envelopes enumerate exactly
  // the event types and run states the host emits.
  const hostFeedEvent = record(schemas.HostFeedEvent, "HostFeedEvent");
  assert.deepEqual(
    record(record(hostFeedEvent.properties, "HostFeedEvent properties").type, "host feed type").enum,
    AIDEN_REMOTE_HOST_FEED_EVENT_TYPES,
  );
  const runEvent = record(schemas.RunEvent, "RunEvent");
  assert.deepEqual(
    record(record(runEvent.properties, "RunEvent properties").type, "run event type").enum,
    AIDEN_REMOTE_RUN_EVENT_TYPES,
  );
  assert.deepEqual(record(schemas.RunState, "RunState").enum, AIDEN_REMOTE_RUN_STATES);
  for (const route of [
    "/runs/{runId}/cancel",
    "/runs/{runId}/approvals/{approvalId}/respond",
    "/runs/{runId}/questions/{promptId}/respond",
    "/runs/{runId}/inputs",
  ]) {
    const post = record(record(paths[route], route).post, `${route} post`);
    assert.equal(post["x-aiden-capability"], "runs:control", route);
    assert(
      (post.parameters as Array<Record<string, unknown>>).some(
        (parameter) => parameter.$ref === "#/components/parameters/IdempotencyKey",
      ),
      `${route} requires an Idempotency-Key`,
    );
  }
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
  const capabilitiesPost = record(
    record(paths["/device/capabilities"], "device capabilities").post,
    "device capabilities post",
  );
  assert.equal(capabilitiesPost["x-aiden-capability"], "server:read");
  const tasksGet = record(
    record(paths["/chats/{chatId}/tasks"], "chat tasks").get,
    "chat tasks get",
  );
  assert.equal(tasksGet["x-aiden-capability"], "chat:read");
  assert.deepEqual(tasksGet["x-aiden-capabilities"], ["chat:read", "tasks:read"]);
  const agentsGet = record(
    record(paths["/chats/{chatId}/agents"], "chat agents").get,
    "chat agents get",
  );
  assert.equal(agentsGet["x-aiden-capability"], "chat:read");
  assert.deepEqual(agentsGet["x-aiden-capabilities"], ["chat:read", "agents:read"]);
  const agentInterruptPost = record(
    record(paths["/chats/{chatId}/agents/{agentId}/interrupt"], "chat agent interrupt").post,
    "chat agent interrupt post",
  );
  assert.equal(agentInterruptPost["x-aiden-capability"], "chat:write");
  assert.deepEqual(agentInterruptPost["x-aiden-capabilities"], ["chat:write", "agents:read"]);
  assert.equal(agentInterruptPost["x-aiden-archived-access"], "mutation_blocked");
  const skillsGet = record(
    record(paths["/chats/{chatId}/skills"], "chat skills").get,
    "chat skills get",
  );
  assert.equal(skillsGet["x-aiden-capability"], "chat:read");
  assert.deepEqual(skillsGet["x-aiden-capabilities"], ["chat:read", "skills:invoke"]);
  const progressEventsGet = record(
    record(paths["/chats/{chatId}/progress/events"], "chat progress events").get,
    "chat progress events get",
  );
  assert.equal(progressEventsGet["x-aiden-capability"], "chat:read");
  assert.deepEqual(
    record(
      record(record(schemas.ChatTaskProgress, "ChatTaskProgress").properties, "ChatTaskProgress properties")
        .availability,
      "task availability",
    ).enum,
    ["ready", "unavailable"],
  );
  assert.equal(
    record(
      record(record(schemas.ChatAgentRoster, "ChatAgentRoster").properties, "ChatAgentRoster properties")
        .agents,
      "roster agents",
    ).maxItems,
    64,
  );
  assert.equal(
    record(
      record(record(schemas.ChatAgentRoster, "ChatAgentRoster").properties, "ChatAgentRoster properties")
        .previousTurns,
      "roster previousTurns",
    ).maxItems,
    AIDEN_REMOTE_CHAT_MAX_PREVIOUS_TURNS,
  );
  const previousTurnSchema = record(schemas.ChatPreviousTurn, "ChatPreviousTurn");
  assert.deepEqual(previousTurnSchema.required, ["turnId", "startedAt"]);
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
  // Only readiness and pairing admission are reachable without a credential.
  const unauthenticatedRoutes = new Set([
    "/health",
    "/pairing/exchange",
    "/pairing/manual-bootstrap",
    "/pairing/requests",
    "/pairing/requests/{requestId}/reveal",
    "/pairing/requests/{requestId}",
  ]);
  for (const [route, pathValue] of Object.entries(paths)) {
    const operations = Object.entries(record(pathValue, route)).filter(([method]) => methods.has(method));
    const publicOperations = operations.filter(
      ([, operationValue]) => JSON.stringify(record(operationValue, route).security) === "[]",
    );
    assert.equal(
      publicOperations.length,
      unauthenticatedRoutes.has(route) ? operations.length : 0,
      `${route} must be either entirely public pairing/readiness or entirely authenticated`,
    );
    if (!unauthenticatedRoutes.has(route)) {
      const inherited = (record(pathValue, route).parameters as Array<Record<string, unknown>> | undefined) ?? [];
      assert(inherited.some((parameter) => parameter.$ref === "#/components/parameters/ProtocolVersion"), `${route} must require the exact protocol-version header`);
    }
    for (const [method, operationValue] of operations) {
      const operationRecord = record(operationValue, `${method} ${route}`);
      if (unauthenticatedRoutes.has(route)) continue;
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

  const botIdQuery = record(parameters.BotIdQuery, "BotIdQuery");
  assert.equal(botIdQuery.name, "botId");
  assert.equal(botIdQuery.in, "query");
  assert.equal(botIdQuery.required, false);
  assert.deepEqual(record(botIdQuery.schema, "BotIdQuery schema"), {
    type: "string",
    minLength: 1,
    maxLength: 160,
    pattern: "^[A-Za-z0-9._:-]+$",
  });
  assert.deepEqual(operation("/bot-capabilities", "get").parameters, [
    { $ref: "#/components/parameters/BotIdQuery" },
  ]);

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
  assert.deepEqual(privateResponseFields.appliesTo, [
    "Chat",
    "ChatSummary",
    "Bot",
    "ChatTaskProgress",
    "ChatAgentRoster",
  ]);
  assert.equal(privateResponseFields.recursive, true);
  assert.equal(
    privateResponseFields.normalization,
    "Remove hyphens, underscores, periods, and whitespace, then lowercase before comparison.",
  );
  assert.deepEqual(privateResponseFields.allowedSchemaProperties, ["BotDetail.instructions"]);
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
    ["get /bot-presets", ["bot:read"]],
    ["post /bots/from-preset", ["bot:read", "bot:write"]],
    ["get /bots/{botId}/session", ["bot:read", "chat:read"]],
    ["get /bots/{botId}/session/events", ["bot:read", "chat:read"]],
    ["post /bots/{botId}/messages", ["bot:read", "bot:write", "chat:write"]],
    ["post /bots/{botId}/resume", ["bot:read", "bot:write"]],
    ["post /bots/{botId}/dismiss", ["bot:read", "bot:write"]],
    ["post /bots/{botId}/stop", ["bot:read", "bot:write"]],
    ["post /bots/{botId}/questions/{waitId}/answer", ["bot:read", "bot:write"]],
    ["post /bots/{botId}/handoffs/{waitId}/answer", ["bot:read", "bot:write", "bot:handoffs"]],
    ["post /bots/{botId}/handoffs/{waitId}/open-on-mac", ["bot:read", "bot:write", "bot:handoffs"]],
    ["post /bots/{botId}/pause", ["bot:read", "bot:write", "bot:handoffs"]],
    ["delete /bots/{botId}/pause", ["bot:read", "bot:write", "bot:handoffs"]],
    ["get /bots/{botId}/routines", ["bot:read"]],
    ["post /bots/{botId}/routines", ["bot:read", "bot:write"]],
    ["patch /bots/{botId}/routines/{routineId}", ["bot:read", "bot:write"]],
    ["delete /bots/{botId}/routines/{routineId}", ["bot:read", "bot:write"]],
    ["post /bots/{botId}/connection-requests", ["bot:read", "bot:write"]],
    ["get /bot-conversations", ["bot:read", "chat:read"]],
    ["post /bots/{botId}/chats", ["bot:read", "bot:write", "chat:write"]],
    ["get /bot-capabilities", ["bot:read"]],
    ["patch /bots/{botId}/capabilities", ["bot:read", "bot:write"]],
    ["get /bot-conversations/{chatId}/files", ["bot:read", "files:read"]],
    ["get /bot-conversations/{chatId}/files/{fileId}", ["bot:read", "files:read"]],
    ["put /bot-conversations/{chatId}/files/{fileId}", ["bot:read", "bot:write", "files:write"]],
    ["put /bots/{botId}/avatar", ["bot:read", "bot:write"]],
    ["delete /bots/{botId}/avatar", ["bot:read", "bot:write"]],
    ["get /bots/{botId}/avatar/{assetRevision}", ["bot:read"]],
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
    "BotSessionState",
    "BotSession",
    "BotMessageRequest",
    "BotMessageReceipt",
    "BotRoutine",
    "BotRoutineList",
    "BotRoutineCreateRequest",
    "BotRoutineUpdateRequest",
    "BotConnectionRequest",
    "BotConnectionRequestReceipt",
    "BotPresetList",
    "BotPresetCreateRequest",
    "BotPresetCreateResult",
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
    "BotAvatarUploadRequest",
    "BotHandoff",
    "BotHandoffAnswerRequest",
    "BotHandoffAnswerReceipt",
    "BotHandoffOpenOnMacReceipt",
  ];
  for (const name of closedBotSchemas) {
    // A schema composed with allOf closes over everything it evaluates instead.
    const schema = record(schemas[name], name);
    assert.equal(schema.additionalProperties ?? schema.unevaluatedProperties, false, `${name} must be closed`);
  }
  for (const name of [
    "BotAccessView",
    "BotAccessUpdateRequest",
    "BotChatCreateRequest",
  ]) {
    const variants = record(schemas[name], name).oneOf;
    assert(Array.isArray(variants));
    assert.equal(variants.length, 2);
    variants.forEach((variant, index) => {
      assert.equal(record(variant, `${name}[${index}]`).additionalProperties, false);
    });
  }
  const avatarSchema = record(schemas.BotSemanticAvatar, "BotSemanticAvatar");
  assert.deepEqual(avatarSchema.required, ["version", "shape", "color"]);
  assert.equal(avatarSchema.additionalProperties, false);
  const avatarProperties = record(avatarSchema.properties, "BotSemanticAvatar properties");
  assert.deepEqual(record(avatarProperties.color, "avatar color").enum, [...AIDEN_REMOTE_BOT_AVATAR_COLOR_VALUES]);
  assert.equal((record(avatarProperties.color, "avatar color").enum as unknown[]).length, 12);

  const botSummary = record(schemas.BotSummary, "BotSummary");
  const botSummaryProperties = record(botSummary.properties, "BotSummary properties");
  assert.deepEqual(botSummary.required, ["id", "name", "purpose", "avatar", "health", "createdAt", "updatedAt", "revision"]);
  assert.equal("instructions" in botSummaryProperties, false, "Bot summaries must not expose instructions");
  assert.equal(record(botSummaryProperties.id, "BotSummary id").maxLength, 160);
  assert.equal(record(botSummaryProperties.purpose, "BotSummary purpose").maxLength, 280);
  assert.equal(botSummary["x-aiden-updated-at-not-before-created-at"], true);
  assert.deepEqual(record(schemas.BotHealth, "BotHealth").enum, ["ready", "degraded", "unavailable"]);
  for (const name of ["BotSummary", "BotDetail"]) {
    assert.equal("archivedAt" in record(record(schemas[name], name).properties, name), false, `${name} carries no archivedAt`);
  }
  const botListProperties = record(record(schemas.BotList, "BotList").properties, "BotList properties");
  assert.equal(record(botListProperties.bots, "Bot list items").maxItems, 256);
  assert.equal(record(botListProperties.maxBots, "Bot list maximum").const, 256);

  const botDetailProperties = record(record(schemas.BotDetail, "BotDetail").properties, "BotDetail properties");
  assert.equal(record(schemas.BotDetail, "BotDetail")["x-aiden-updated-at-not-before-created-at"], true);
  assert.equal(record(botDetailProperties.instructions, "instructions").maxLength, 32_000);
  // Revision 27 retired the greeting: never emitted, accepted and ignored in requests.
  assert.equal("openingGreeting" in botDetailProperties, false);
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
  assert.deepEqual(Object.keys(record(identityPatch.properties, "BotIdentityPatch properties")), ["name", "purpose", "openingGreeting", "instructions", "avatar", "chatActivity"]);

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
  assert.deepEqual(Object.keys(catalogProperties), ["revision", "providers", "fileScopes", "shellAvailable", "connections", "skillsEnabled", "skills", "otherCapabilities"]);
  assert.equal(record(catalogProperties.providers, "providers").maxItems, 64);
  assert.equal(
    record(catalogProperties.providers, "providers")["x-aiden-max-total-models"],
    512,
  );
  assert.equal(record(catalogProperties.connections, "connections").maxItems, 128);
  assert.equal(record(catalogProperties.skills, "skills").maxItems, 256);
  assert.equal(record(catalogProperties.skillsEnabled, "skillsEnabled").type, "boolean");
  assert.equal(record(catalogProperties.skillsEnabled, "skillsEnabled").default, true);
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
  const botChatCreateVariants = record(schemas.BotChatCreateRequest, "BotChatCreateRequest").oneOf as unknown[];
  assert.equal(record(schemas.BotChatCreateRequest, "BotChatCreateRequest")["x-aiden-provider-model-must-be-currently-available"], true);
  assert.equal(record(botChatCreateVariants[0], "inherited Bot chat create").maxProperties, 0);
  assert.deepEqual(record(botChatCreateVariants[1], "selected Bot chat create").required, [
    "providerId",
    "modelId",
  ]);
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
    ["/bots/{botId}/avatar", "put", "BotAvatarUploadRequest"],
  ] as const) {
    assert.equal(requestSchemaRef(route, method), `#/components/schemas/${schema}`);
  }
  for (const [route, method, status, schema] of [
    ["/bots", "get", "200", "BotList"],
    ["/bots", "post", "201", "BotDetail"],
    ["/bots/{botId}", "get", "200", "BotDetail"],
    ["/bots/{botId}", "patch", "200", "BotDetail"],
    ["/bot-conversations", "get", "200", "BotConversationPage"],
    ["/bots/{botId}/chats", "post", "201", "BotChatCreateResponse"],
    ["/bot-capabilities", "get", "200", "BotCapabilityCatalog"],
    ["/bots/{botId}/capabilities", "patch", "200", "BotAccessView"],
    ["/bot-conversations/{chatId}/files", "get", "200", "FileIndex"],
    ["/bot-conversations/{chatId}/files/{fileId}", "get", "200", "FileDocument"],
    ["/bot-conversations/{chatId}/files/{fileId}", "put", "200", "FileDocument"],
    ["/bots/{botId}/avatar", "put", "200", "BotAvatarAsset"],
    ["/bots/{botId}/avatar", "delete", "200", "BotDetail"],
    ["/bot-presets", "get", "200", "BotPresetList"],
    ["/bots/from-preset", "post", "201", "BotPresetCreateResult"],
    ["/bots/{botId}/session", "get", "200", "BotSession"],
    ["/bots/{botId}/messages", "post", "200", "BotMessageReceipt"],
    ["/bots/{botId}/attachments", "post", "201", "AttachmentReference"],
    ["/bots/{botId}/resume", "post", "200", "BotSessionState"],
    ["/bots/{botId}/dismiss", "post", "200", "BotSessionState"],
    ["/bots/{botId}/stop", "post", "200", "BotSessionState"],
    ["/bots/{botId}/questions/{waitId}/answer", "post", "200", "BotQuestionAnswerReceipt"],
    ["/bots/{botId}/handoffs/{waitId}/answer", "post", "200", "BotHandoffAnswerReceipt"],
    ["/bots/{botId}/handoffs/{waitId}/open-on-mac", "post", "200", "BotHandoffOpenOnMacReceipt"],
    ["/bots/{botId}/pause", "post", "200", "BotSessionState"],
    ["/bots/{botId}/pause", "delete", "200", "BotSessionState"],
    ["/bots/{botId}/routines", "get", "200", "BotRoutineList"],
    ["/bots/{botId}/routines", "post", "201", "BotRoutine"],
    ["/bots/{botId}/routines/{routineId}", "patch", "200", "BotRoutine"],
    ["/bots/{botId}/connection-requests", "post", "200", "BotConnectionRequestReceipt"],
    ["/bots/{botId}/memory", "get", "200", "BotMemory"],
    ["/bots/{botId}/memory/edits", "post", "200", "BotMemoryEditResponse"],
    ["/bots/{botId}/routine-proposals/{proposalId}/respond", "post", "200", "BotRoutineProposalRespondResult"],
    ["/bots/{botId}/routine-suggestions", "get", "200", "BotRoutineSuggestionList"],
    ["/bots/routine-notifications", "get", "200", "BotRoutineNotificationList"],
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
    ["/chats/{chatId}/fork", "post"],
    ["/chats/{chatId}/turns", "post"],
    ["/bots", "post"],
    ["/bots/{botId}/chats", "post"],
    ["/bots/{botId}/avatar", "put"],
    ["/streams/{streamId}/cancel", "post"],
    ["/streams/{streamId}/inputs", "post"],
    ["/approvals/{approvalId}/respond", "post"],
    ["/questions/{promptId}/respond", "post"],
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
    ["/bots/{botId}/handoffs/{waitId}/answer", "post"],
    ["/bots/{botId}/handoffs/{waitId}/open-on-mac", "post"],
    ["/bots/{botId}/pause", "post"],
    ["/bots/{botId}/pause", "delete"],
  ] as const) {
    assert(parameterRefs(route, method).includes("#/components/parameters/IdempotencyKey"));
  }

  for (const [route, method] of [
    ["/workspaces/{workspaceId}", "patch"],
    ["/workspaces/{workspaceId}", "delete"],
    ["/chats/{chatId}", "patch"],
    ["/chats/{chatId}", "delete"],
    ["/chats/{chatId}/fork", "post"],
    ["/bots/{botId}", "patch"],
    ["/bots/{botId}", "delete"],
    ["/bots/{botId}/capabilities", "patch"],
    ["/bots/{botId}/avatar", "put"],
    ["/bots/{botId}/avatar", "delete"],
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

  // The new progress projections are bounded public surfaces: private or
  // additive unknown fields fail closed at every level, not only on legacy
  // transcript shapes.
  for (const [mutate, label] of [
    [(draft: Record<string, unknown>) => { record(draft.taskProgress, "taskProgress").absolutePath = "/private/secret"; }, "taskProgress root"],
    [(draft: Record<string, unknown>) => { record((record(draft.taskProgress, "taskProgress").tasks as unknown[])[0], "task").childTranscript = ["secret"]; }, "taskProgress task"],
    [(draft: Record<string, unknown>) => { record(draft.agentRoster, "agentRoster").providerCredential = "secret"; }, "agentRoster root"],
    [(draft: Record<string, unknown>) => { record((record(draft.agentRoster, "agentRoster").agents as unknown[])[0], "agent").childResult = "secret"; }, "agentRoster agent"],
    [(draft: Record<string, unknown>) => { record((draft.chatProgressEvents as unknown[])[0], "event").payload = { ...record(record((draft.chatProgressEvents as unknown[])[0], "event").payload, "payload"), hiddenPrompt: "secret" }; }, "chatProgressEvents payload"],
    [(draft: Record<string, unknown>) => { record(draft.deviceCapabilitiesUpdate, "deviceCapabilitiesUpdate").sessionId = "private"; }, "deviceCapabilitiesUpdate"],
  ] as const) {
    const mutated = clone();
    mutate(mutated);
    assert.throws(() => parseAidenRemoteContractFixture(mutated), /Forbidden private Bot wire key|private child field|unsupported field|unsupported key/i, label);
  }
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

  const progressHeartbeat = clone();
  const progressEvents = progressHeartbeat.chatProgressEvents;
  assert(Array.isArray(progressEvents));
  progressHeartbeat.chatProgressEvents = [
    ...progressEvents,
    {
      ...record(progressEvents[0], "progress event"),
      sequence: progressEvents.length + 1,
      type: "heartbeat",
      payload: {},
    },
  ];
  assert.throws(
    () => parseAidenRemoteContractFixture(progressHeartbeat),
    /Chat progress events must be nonterminal updates/u,
  );
  const ordinaryProgress = clone();
  assert(Array.isArray(ordinaryProgress.events));
  ordinaryProgress.events = [
    {
      ...record(progressEvents[0], "progress event"),
      streamId: "stream_fixture_01",
      sequence: 1,
    },
    ...ordinaryProgress.events.slice(1),
  ];
  assert.throws(
    () => parseAidenRemoteContractFixture(ordinaryProgress),
    /task_update payload chatId must match the event streamId/u,
  );
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

test("chat parser limits reasoning to regular assistants and 100,000 UTF-16 units", () => {
  const projection = {
    id: "chat-1", workspaceId: "workspace-1", title: "Chat",
    messages: [{ id: "message-1", role: "assistant", text: "Done", reasoning: "visible",
      createdAt: "2026-08-23T00:00:00.000Z" }],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z", revision: "revision-1",
  };
  assert.equal(parseAidenRemoteChatProjection(projection).messages[0]?.reasoning, "visible");
  assert.throws(() => parseAidenRemoteChatProjection({ ...projection, botId: "bot-1" }),
    /regular-assistant-only/u);
  assert.throws(() => parseAidenRemoteChatProjection({ ...projection,
    messages: [{ ...projection.messages[0], reasoning: "😀".repeat(60_000) }],
  }), /UTF-16/u);
  assert.equal(parseAidenRemoteChatProjection({ ...projection,
    messages: [{ ...projection.messages[0], reasoning: "😀".repeat(50_000) }],
  }).messages[0]?.reasoning?.length, 100_000);
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

test("produced-file OpenAPI constraints agree with runtime path and provenance validation", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const { parseProducedFile } = await import("../../renderer/shared/produced-file.js");
  const spec = await json("openapi.json") as { components: { schemas: Record<string, object> } };
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile({ $ref: "#/components/schemas/GenerationToolStep", components: spec.components });
  const base = { id: "tool-1", order: 0, kind: "tool", toolCallId: "call-1", toolName: "write_file", label: "Write file", status: "completed", startedAt: 1, updatedAt: 1 };
  for (const relativePath of [...["\u2028", "\u2029"].flatMap((separator) => [`a/${separator}/b`, `a/${separator}/../b`, `a/${separator}/./b`, `a/${separator}//b`, `a/${separator}/`]), "out/report.txt", "foo:bar.txt", "a:b/c.txt", "K:/secret", "😀".repeat(121), "😀".repeat(241), "/abs", "../secret", "a/../b", "a/./b", "a\\b", "a//b", "a/", "~file", "C:/secret", "bad\nname"]) {
    const file = { relativePath, operation: "written", bytes: 12 };
    assert.equal(validate({ ...base, producedFile: file }), Boolean(parseProducedFile(file, "write_file")), relativePath);
  }
  const producedFile = { relativePath: "report.txt", operation: "written", bytes: 12 };
  assert.equal(validate({ ...base, producedFile, status: "failed" }), false);
  assert.equal(validate({ ...base, producedFile, toolName: "mcp_write" }), false);
  assert.equal(validate({ ...base, producedFile, toolName: "edit_file" }), false);
  assert.equal(validate({ ...base, producedFile: { ...producedFile, operation: "edited" }, toolName: "edit_file" }), true);
});

test("questionnaire recap OpenAPI constraints agree with the runtime timeline parser", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const spec = await json("openapi.json") as { components: { schemas: Record<string, object> } };
  const ajv = new Ajv2020({ strict: false });
  const validateTimeline = ajv.compile({ $ref: "#/components/schemas/GenerationTimeline", components: spec.components });
  const step = { id: "tool-1", order: 0, kind: "tool", toolCallId: "call-1", toolName: "ask_user_question", label: "Ask a question", status: "completed", startedAt: 1, updatedAt: 1, finishedAt: 1, contentOffset: 0 };
  const timeline = (questionnaire: unknown, overrides: Record<string, unknown> = {}) => ({
    version: 3,
    generationId: "gen-1",
    status: "completed",
    startedAt: 1,
    finishedAt: 1,
    steps: [{ ...step, ...overrides, questionnaire }],
  });
  const item = (kind: string, answers: string[], question = "Which format?", header = "Format") => ({ question, header, kind, answers });
  const answered = (...items: unknown[]) => ({ version: 1, outcome: "answered", items });
  const cases: Array<[name: string, candidate: Record<string, unknown>, expected: boolean]> = [
    ["option and skipped", timeline(answered(item("option", ["Plain text"]), item("skipped", []))), true],
    ["multi and multi-line custom", timeline(answered(item("multi", ["A", "B"]), item("custom", ["line one\n\tline two"]))), true],
    ["dismissed, all skipped", timeline({ version: 1, outcome: "dismissed", items: [item("skipped", [])] }), true],
    ["expired, all skipped", timeline({ version: 1, outcome: "expired", items: [item("skipped", []), item("skipped", [])] }), true],
    ["four items", timeline(answered(...Array.from({ length: 4 }, () => item("skipped", [])))), true],
    ["60 astral code points in a label", timeline(answered(item("option", ["😀".repeat(60)]))), true],
    ["61 code points in a label", timeline(answered(item("option", ["x".repeat(61)]))), false],
    ["1000 astral code points of custom text", timeline(answered(item("custom", ["😀".repeat(1000)]))), true],
    ["1001 code points of custom text", timeline(answered(item("custom", ["x".repeat(1001)]))), false],
    ["16 astral code points in a header", timeline(answered(item("skipped", [], "Which?", "😀".repeat(16)))), true],
    ["17 code points in a header", timeline(answered(item("skipped", [], "Which?", "x".repeat(17)))), false],
    ["line separator in a question", timeline(answered(item("skipped", [], "a b"))), true],
    ["duplicate multi labels", timeline(answered(item("multi", ["A", "A"]))), false],
    ["six multi labels", timeline(answered(item("multi", ["A", "B", "C", "D", "E", "F"]))), false],
    ["empty multi", timeline(answered(item("multi", []))), false],
    ["two option labels", timeline(answered(item("option", ["A", "B"]))), false],
    ["two custom answers", timeline(answered(item("custom", ["A", "B"]))), false],
    ["skipped with an answer", timeline(answered(item("skipped", ["A"]))), false],
    ["dismissed with an option answer", timeline({ version: 1, outcome: "dismissed", items: [item("option", ["A"])] }), false],
    ["expired with a custom answer", timeline({ version: 1, outcome: "expired", items: [item("custom", ["A"])] }), false],
    ["bell in a question", timeline(answered(item("skipped", [], "ring\u0007"))), false],
    ["carriage return in an answer", timeline(answered(item("custom", ["a\rb"]))), false],
    ["DEL in a header", timeline(answered(item("skipped", [], "Which?", "Fo\u007Frmat"))), false],
    ["blank question", timeline(answered(item("skipped", [], " \n\t "))), false],
    ["no-break-space header", timeline(answered(item("skipped", [], "Which?", " ﻿"))), false],
    ["blank option label", timeline(answered(item("option", ["  "]))), false],
    ["five items", timeline(answered(...Array.from({ length: 5 }, () => item("skipped", [])))), false],
    ["no items", timeline(answered()), false],
    ["unknown recap version", timeline({ version: 2, outcome: "answered", items: [item("skipped", [])] }), false],
    ["unknown outcome", timeline({ version: 1, outcome: "cancelled", items: [item("skipped", [])] }), false],
    ["unknown kind", timeline(answered(item("text", ["A"]))), false],
    ["wrong tool", timeline(answered(item("option", ["A"])), { toolName: "read_file", label: "Read file" }), false],
    ["failed step", timeline(answered(item("option", ["A"])), { status: "failed" }), false],
    ["running step", timeline(answered(item("option", ["A"])), { status: "running", finishedAt: undefined }), false],
  ];
  const { contentOffset: _offset, ...versionTwoStep } = step;
  cases.push([
    "version 2 timeline",
    { version: 2, generationId: "gen-1", status: "completed", startedAt: 1, finishedAt: 1, steps: [{ ...versionTwoStep, questionnaire: answered(item("option", ["A"])) }] },
    false,
  ]);
  for (const [name, candidate, expected] of cases) {
    const wire = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
    assert.equal(validateTimeline(wire), expected, `schema: ${name} ${JSON.stringify(validateTimeline.errors)}`);
    assert.equal(Boolean(parseGenerationTimeline(wire)), expected, `runtime: ${name}`);
  }
  // Without the recap, the base step is valid on both sides, so each rejection
  // above comes from the questionnaire rule rather than the surrounding step.
  const { questionnaire: _q, ...bare } = record((timeline(undefined).steps as unknown[])[0], "step");
  for (const overrides of [{}, { toolName: "read_file", label: "Read file" }, { status: "failed" }]) {
    const plain = { ...timeline(undefined), steps: [{ ...bare, ...overrides }] };
    assert.equal(validateTimeline(plain), true, JSON.stringify(overrides));
    assert.ok(parseGenerationTimeline(plain), JSON.stringify(overrides));
  }
  const versionTwo = { version: 2, generationId: "gen-1", status: "completed", startedAt: 1, finishedAt: 1, steps: [versionTwoStep] };
  assert.equal(validateTimeline(versionTwo), true);
  assert.ok(parseGenerationTimeline(versionTwo));
});

test("web page extract recap OpenAPI constraints agree with the runtime timeline parser", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const spec = await json("openapi.json") as { components: { schemas: Record<string, object> } };
  const ajv = new Ajv2020({ strict: false });
  const validateTimeline = ajv.compile({ $ref: "#/components/schemas/GenerationTimeline", components: spec.components });
  const step = { id: "tool-1", order: 0, kind: "tool", toolCallId: "call-1", toolName: "web_fetch", label: "Fetch web page", status: "completed", startedAt: 1, updatedAt: 1, finishedAt: 1, contentOffset: 0, detail: "acme.example" };
  const timeline = (extraction: unknown, overrides: Record<string, unknown> = {}) => ({
    version: 3,
    generationId: "gen-1",
    status: "completed",
    startedAt: 1,
    finishedAt: 1,
    steps: [{ ...step, ...overrides, extraction }],
  });
  const read = { name: "pro_monthly", status: "extracted", value: "20", confidence: 0.97, sourceLine: "Pro is $20 per month." };
  const recap = (fields: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, host: "acme.example", cut: false, fields, ...extra });
  const cases: Array<[name: string, candidate: Record<string, unknown>, expected: boolean]> = [
    ["extracted, uncertain and null", timeline(recap([read, { name: "seats", status: "uncertain", value: "50", confidence: 0.4, sourceLine: "Up to 50 seats." }, { name: "enterprise", status: "null" }])), true],
    ["a guess that is not on the page", timeline(recap([{ name: "team", status: "uncertain", value: "1399", notFound: true }])), true],
    ["an uncertain field with nothing to show", timeline(recap([{ name: "team", status: "uncertain" }])), true],
    ["cut page", timeline(recap([read], { cut: true })), true],
    ["failed extraction", timeline(recap([], { error: "quota" })), true],
    ["sixteen fields", timeline(recap(Array.from({ length: 16 }, (_, index) => ({ name: `f${index}`, status: "null" })))), true],
    ["200 astral code points in a value", timeline(recap([{ ...read, value: "😀".repeat(200) }])), true],
    ["201 code points in a source line", timeline(recap([{ ...read, sourceLine: "x".repeat(201) }])), false],
    ["seventeen fields", timeline(recap(Array.from({ length: 17 }, (_, index) => ({ name: `f${index}`, status: "null" })))), false],
    ["no fields and no error", timeline(recap([])), false],
    ["an error with fields", timeline(recap([read], { error: "quota" })), false],
    ["unknown error", timeline(recap([], { error: "teapot" })), false],
    ["extracted without its page line", timeline(recap([{ name: "pro", status: "extracted", value: "20", confidence: 0.9 }])), false],
    ["extracted without confidence", timeline(recap([{ name: "pro", status: "extracted", value: "20", sourceLine: "Pro is $20." }])), false],
    ["extracted marked not found", timeline(recap([{ ...read, notFound: true }])), false],
    ["null with a value", timeline(recap([{ name: "pro", status: "null", value: "20" }])), false],
    ["notFound false", timeline(recap([{ name: "pro", status: "uncertain", notFound: false }])), false],
    ["confidence above one", timeline(recap([{ ...read, confidence: 1.2 }])), false],
    ["field name with a space", timeline(recap([{ name: "pro monthly", status: "null" }])), false],
    ["newline in a source line", timeline(recap([{ ...read, sourceLine: "Pro is\n$20" }])), false],
    ["double space in a value", timeline(recap([{ ...read, value: "20  USD" }])), false],
    ["trailing space in the host", timeline(recap([read], { host: "acme.example " })), false],
    ["no-break space in a value", timeline(recap([{ ...read, value: "20 USD" }])), false],
    ["unknown status", timeline(recap([{ name: "pro", status: "maybe" }])), false],
    ["unknown recap version", timeline({ ...recap([read]), version: 2 }), false],
    ["wrong tool", timeline(recap([read]), { toolName: "web_search", label: "Search the web" }), false],
    ["failed step", timeline(recap([read]), { status: "failed" }), false],
  ];
  const { contentOffset: _offset, ...versionTwoStep } = step;
  cases.push([
    "version 2 timeline",
    { version: 2, generationId: "gen-1", status: "completed", startedAt: 1, finishedAt: 1, steps: [{ ...versionTwoStep, extraction: recap([read]) }] },
    false,
  ]);
  for (const [name, candidate, expected] of cases) {
    const wire = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
    assert.equal(validateTimeline(wire), expected, `schema: ${name} ${JSON.stringify(validateTimeline.errors)}`);
    assert.equal(Boolean(parseGenerationTimeline(wire)), expected, `runtime: ${name}`);
  }
  // The wire refuses keys it does not name; the runtime parser rebuilds the
  // recap, so a stray key never reaches what the host sends.
  const stray = timeline(recap([read], { page: "the whole page" }));
  assert.equal(validateTimeline(stray), false);
  const rebuilt = parseGenerationTimeline(stray);
  assert.ok(rebuilt);
  assert.equal(validateTimeline(JSON.parse(JSON.stringify(rebuilt))), true);
  // Without the recap the base step is valid on both sides, so each rejection
  // above comes from the extraction rule rather than the surrounding step.
  const { extraction: _e, ...bare } = record((timeline(undefined).steps as unknown[])[0], "step");
  for (const overrides of [{}, { toolName: "web_search", label: "Search the web" }, { status: "failed" }]) {
    const plain = { ...timeline(undefined), steps: [{ ...bare, ...overrides }] };
    assert.equal(validateTimeline(plain), true, JSON.stringify(overrides));
    assert.ok(parseGenerationTimeline(plain), JSON.stringify(overrides));
  }
});

test("approval scope schemas accept the shared fixture and only allow-with-scope requests", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const spec = await json("openapi.json") as {
    components: { schemas: Record<string, object> };
    paths: Record<string, { post: { requestBody: { content: Record<string, { schema: object }> } } }>;
  };
  const fixture = await json("fixtures/contract.json") as { streamApproval: { approval: Record<string, unknown> } };
  const ajv = new Ajv2020({ strict: false });
  const pending = ajv.compile({ $ref: "#/components/schemas/PendingApproval", components: spec.components });
  const request = ajv.compile({
    ...spec.paths["/approvals/{approvalId}/respond"]!.post.requestBody.content["application/json"]!.schema,
    components: spec.components,
  });
  const approval = fixture.streamApproval.approval;
  assert.equal(pending(approval), true);
  const { scopes: _scopes, ...legacy } = approval;
  assert.equal(pending(legacy), true, "revision 16 servers omit scopes");
  assert.equal(pending({ ...approval, scopes: ["once"] }), false, "a once-only offer is omitted, not listed");
  assert.equal(pending({ ...approval, scopes: ["once", "forever"] }), false);

  assert.equal(request({ decision: "allow" }), true);
  assert.equal(request({ decision: "allow", scope: "always" }), true);
  assert.equal(request({ decision: "deny", scope: "chat" }), false);
  assert.equal(request({ decision: "allow", scope: "workspace" }), false);
});

test("pairing request OpenAPI schemas accept the shared fixture and keep phones and stray envelopes out", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const spec = await json("openapi.json") as { components: { schemas: Record<string, object> } };
  const fixture = parseAidenRemoteContractFixture(await json("fixtures/contract.json"));
  const section = fixture.pairingRequests!;
  const ajv = new Ajv2020({ strict: false });
  const schema = (name: string) => ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  const create = schema("PairingRequestCreate");
  const created = schema("PairingRequestCreated");
  const status = schema("PairingRequestStatus");
  assert.equal(create(section.create.request), true);
  assert.equal(created(section.create.response), true);
  assert.equal(schema("PairingRequestReveal")(section.reveal.request), true);
  assert.equal(schema("PairingRequestRevealed")(section.reveal.response), true);
  for (const entry of section.status) assert.equal(status(entry), true, entry.state);
  assert.equal(schema("ErrorEnvelope")(section.error), true);

  assert.equal(create({ ...section.create.request, deviceType: "iphone" }), false);
  assert.equal(create({ ...section.create.request, credential: "x" }), false);
  const approved = section.status.find((entry) => entry.state === "approved")!;
  const { envelope, ...withoutEnvelope } = approved;
  assert.equal(status(withoutEnvelope), false, "approved always carries its envelope");
  assert.equal(status({ ...withoutEnvelope, state: "denied", envelope }), false, "a denial never carries a credential");
});

test("stream input contracts reject unknown modes, oversized text, and unknown reasons", () => {
  const admitted = parseAidenRemoteStreamInputResult({
    streamId: "stream_1",
    chatId: "chat_1",
    turnId: "turn_1",
    mode: "steer",
    status: "admitted",
    queue: "steer",
    committed: true,
    messageId: "msg_1",
  });
  assert.equal(admitted.mode, "steer");
  assert.equal(admitted.status, "admitted");
  assert.equal(admitted.queue, "steer");

  const rejected = parseAidenRemoteStreamInputResult({
    streamId: "stream_1",
    chatId: "chat_1",
    turnId: "turn_1",
    mode: "queue",
    status: "rejected",
    reason: "capacity",
    committed: false,
  });
  assert.equal(rejected.reason, "capacity");

  assert.throws(
    () => parseAidenRemoteStreamInputRequest({ mode: "read", text: "x" }),
    /mode/u,
  );
  assert.throws(
    () => parseAidenRemoteStreamInputRequest({ mode: "steer", text: "x".repeat(200_001) }),
    /text/u,
  );
  assert.throws(
    () => parseAidenRemoteStreamInputResult({
      streamId: "stream_1",
      chatId: "chat_1",
      turnId: "turn_1",
      mode: "queue",
      status: "rejected",
      reason: "violence",
      committed: false,
    }),
    /reason/u,
  );
  // Admitted receipts must name the queue lane; rejected receipts must not.
  assert.throws(
    () => parseAidenRemoteStreamInputResult({
      streamId: "stream_1",
      chatId: "chat_1",
      turnId: "turn_1",
      mode: "steer",
      status: "admitted",
      committed: true,
    }),
    /queue/u,
  );
});

test("provider creation schemas accept the shared keyless fixture and reject unsafe credential shapes", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const spec = await json("openapi.json") as { components: { schemas: Record<string, object> } };
  const fixture = await json("fixtures/contract.json") as { providerCreation: Record<string, unknown>; providerCreationReceipt: Record<string, unknown> };
  const ajv = new Ajv2020({ strict: false });
  const request = ajv.compile({ $ref: "#/components/schemas/ProviderCreation", components: spec.components });
  const receipt = ajv.compile({ $ref: "#/components/schemas/ProviderCreationReceipt", components: spec.components });
  assert.equal(request(fixture.providerCreation), true, JSON.stringify(request.errors));
  assert.equal(receipt(fixture.providerCreationReceipt), true, JSON.stringify(receipt.errors));
  assert.equal(request({ ...fixture.providerCreation, apiKey: "unneeded-key" }), false);
  assert.equal(request({ ...fixture.providerCreation, needsKey: true }), false);
  assert.equal(request({ ...fixture.providerCreation, confirmedForeground: false }), false);
  assert.equal(request({ ...fixture.providerCreation, extra: true }), false);
  assert.equal(receipt({ ...fixture.providerCreationReceipt, apiKey: "leaked-key" }), false);
});

test("fork lineage parses on chats and rows, and a prefill only follows a fork before a prompt", async () => {
  const fixture = record(await json("fixtures/contract.json"), "fixture");
  const chatFork = record(fixture.chatFork, "chatFork");
  const fork = record(record(chatFork.fork, "fork").response, "fork response");
  const editFork = record(record(chatFork.editFork, "editFork").response, "editFork response");
  const clone = <T>(value: T): T => structuredClone(value);
  const forkChat = () => clone(record(fork.chat, "chat"));
  const lineage = () => record(forkChat().forkedFrom, "forkedFrom");

  const parsed = parseAidenRemoteChatForkResult(clone(fork));
  assert.equal(parsed.chat.forkedFrom?.chatId, "chat_fixture_source_01");
  assert.equal(parsed.chat.forkedFrom?.summary?.state, "pending");
  assert.equal(parsed.prefill, undefined);
  const edit = parseAidenRemoteChatForkResult(clone(editFork));
  assert.equal(edit.prefill?.text, "Now check the error codes.");
  assert.equal(edit.prefill?.attachments?.[0]?.name, "codes.txt");

  // A prompt to edit exists only when the fork cut before it.
  assert.throws(
    () => parseAidenRemoteChatForkResult({ ...clone(fork), prefill: { text: "x" } }),
    /prefill belongs to a fork before a prompt/u,
  );
  // A fork response always names its source.
  const { forkedFrom: _lineage, ...plainChat } = forkChat();
  assert.throws(() => parseAidenRemoteChatForkResult({ chat: plainChat }), /must carry forkedFrom/u);
  // A prefill is one turn, which holds at most ten attachments.
  const prefill = clone(record(editFork.prefill, "prefill"));
  const attachment = (prefill.attachments as unknown[])[0];
  assert.throws(
    () => parseAidenRemoteChatForkResult({
      ...clone(editFork),
      prefill: { ...prefill, attachments: Array.from({ length: 11 }, () => attachment) },
    }),
    /at most 10/u,
  );
  // The next turn redeems restaged attachments by their upload ID.
  assert.throws(
    () => parseAidenRemoteChatForkResult({
      ...clone(editFork),
      prefill: { ...prefill, attachments: [{ ...record(attachment, "attachment"), id: "attachment_1" }] },
    }),
    /uploaded attachment ID/u,
  );
  for (const change of [
    { position: "middle" },
    { chatId: "../other" },
    { at: "yesterday" },
    { summary: { state: "pending" } },
    { extra: true },
    // The desktop keeps the files a summary saw, and calls the focus instructions; neither crosses the wire.
    { summary: { state: "pending", afterMessageId: "m1", files: { read: [], modified: [] } } },
    { summary: { state: "pending", afterMessageId: "m1", instructions: "the parser" } },
    { summary: { state: "ready", afterMessageId: "m1" } },
    { summary: { state: "pending", afterMessageId: "m1", error: "Summary cancelled." } },
  ]) {
    const chat = forkChat();
    chat.forkedFrom = { ...lineage(), ...change };
    assert.throws(() => parseAidenRemoteChatForkResult({ chat }), Error, JSON.stringify(change));
  }

  // A Chat read carries every settled summary state.
  for (const summary of chatFork.summaryStates as unknown[]) {
    const chat = forkChat();
    chat.forkedFrom = { ...lineage(), summary };
    assert.deepEqual(parseAidenRemoteChatForkResult({ chat }).chat.forkedFrom?.summary, summary);
  }

  // Rows show lineage for the sidebar glyph but never carry the summary.
  const row = clone(record((record(fixture.chatSummaries, "chatSummaries").summaries as unknown[])[0], "row"));
  const { summary: _summary, ...rowLineage } = lineage();
  assert.deepEqual(parseAidenRemoteChatSummaryProjection({ ...row, forkedFrom: rowLineage }).forkedFrom, rowLineage);
  assert.equal(parseAidenRemoteChatSummaryProjection(row).forkedFrom, undefined);
  assert.throws(() => parseAidenRemoteChatSummaryProjection({ ...row, forkedFrom: lineage() }));
});

test("mobile simulator fixtures pin the phone viewer's listing, input and MJPEG shapes from revision 26", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, unknown>;
  const section = parseAidenRemoteContractFixture(raw).mobileSimulators;
  assert.ok(section);
  assert.equal(section.capability, "simulators:mobile");
  // The listing carries a running Android emulator and a stopped AVD (listed by
  // its AVD name), both shown on a phone as "Open on your Mac to view".
  assert.deepEqual(
    (section.listing.devices as Array<{ id: string; platform: string }>).map(({ id, platform }) => [id, platform]),
    [
      ["5A0C1F3E-0000-4000-8000-000000000001", "ios"],
      ["5A0C1F3E-0000-4000-8000-000000000002", "ios"],
      ["emulator-5554", "android"],
      ["Pixel_9_API_35", "android"],
    ],
  );
  // The second sample frame contains the boundary bytes, so only Content-Length frames it.
  const second = Buffer.from(section.mjpeg.framesBase64[1]!, "base64");
  assert.ok(second.includes(Buffer.from("\r\n--frame")));

  const mutate = (change: (copy: Record<string, unknown>) => void) => () => {
    const copy = structuredClone(raw);
    change(copy);
    return parseAidenRemoteContractFixture(copy);
  };
  const mobile = (copy: Record<string, unknown>) => record(copy.mobileSimulators, "mobileSimulators");
  assert.throws(
    mutate((copy) => {
      delete (record(mobile(copy).listing, "listing").devices as Array<Record<string, unknown>>)[2]!.platform;
    }),
    /missing platform/u,
  );
  // The fixture admits exactly the ids the desktop lists: a leading dot or a path separator never parses.
  for (const id of [".hidden", "../hub/admin", "a b", "x".repeat(129)]) {
    assert.throws(
      mutate((copy) => {
        (record(mobile(copy).listing, "listing").devices as Array<Record<string, unknown>>)[3]!.id = id;
      }),
      /device 3 id is invalid/u,
      id,
    );
  }
  assert.throws(
    mutate((copy) => {
      record(mobile(copy).listing, "listing").chatDeviceIds = ["NOT-LISTED"];
    }),
    /chatDeviceIds must name listed devices/u,
  );
  assert.throws(
    mutate((copy) => {
      record(mobile(copy).sharingOff, "sharingOff").devices = [
        { id: "A", name: "iPhone", platform: "ios", version: "26.0", booted: true, kind: "iphone" },
      ];
    }),
    /no devices while sharing is off/u,
  );
  assert.throws(
    mutate((copy) => {
      // A phone never sends the Duo hinge command or keyboard keys through this contract.
      (mobile(copy).inputMessages as Array<Record<string, unknown>>)[0]!.tag = 0x10;
    }),
    /tag phones never send/u,
  );
  assert.throws(
    mutate((copy) => {
      record(mobile(copy).refusal, "refusal").error = {
        code: "not_found",
        message: "x",
        requestId: "request_fixture_sim_01",
        retryable: false,
      };
    }),
    /must be capability_denied/u,
  );
  assert.throws(
    mutate((copy) => {
      delete copy.phoneRunEvents;
      delete copy.chatFork;
      copy.contractRevision = 25;
      record(copy.hostHealth, "hostHealth").contractRevision = 25;
    }),
    /require contract revision 26/u,
  );
});

test("chat visuals arrive in revision 28 and a malformed visual never costs its message", async () => {
  const raw = await json("fixtures/contract.json");
  const fixture = parseAidenRemoteContractFixture(raw);
  const message = fixture.chat.messages.find((entry) => entry.visuals?.length);
  assert.deepEqual(message?.visuals?.map((visual) => [visual.kind, visual.toolCallId]), [["html", "call-1"], ["ui", "call-2"]]);
  // Every snapshot names an image attachment on the same message.
  for (const visual of message?.visuals ?? []) {
    assert.equal(message?.attachments?.find((attachment) => attachment.id === visual.snapshotAttachmentId)?.kind, "image");
  }

  const chat = structuredClone(record(raw, "fixture").chat) as { messages: Record<string, unknown>[] };
  const target = chat.messages.find((entry) => Array.isArray(entry.visuals))!;
  const [html, ui] = target.visuals as Record<string, unknown>[];
  target.visuals = [
    { ...html, snapshotAttachmentId: "attachment-that-is-not-here" },
    { ...ui, kind: "video" },
    { ...ui, id: "ui_fixture_02", title: " padded " },
    { ...ui, id: "ui_fixture_03", toolCallId: "tool_fixture_01" },
    { ...ui, id: "ui_fixture_04", privateTree: {} },
    ui,
  ];
  const parsed = parseAidenRemoteChatProjection(chat);
  const kept = parsed.messages.find((entry) => entry.id === target.id);
  assert.equal(kept?.text, target.text);
  assert.deepEqual(kept?.visuals?.map((visual) => visual.id), ["ui_fixture_01"]);

  // A revision-27 Mac (Bot memory, no visuals) cannot carry them.
  const revision27 = structuredClone(raw) as Record<string, unknown>;
  revision27.contractRevision = 27;
  record(revision27.hostHealth, "hostHealth").contractRevision = 27;
  assert.throws(() => parseAidenRemoteContractFixture(revision27), /require contract revision 28/u);
});

test("failed-turn entries parse strictly, with and without a message to retry", async () => {
  const raw = (await json("fixtures/contract.json")) as { botSessionFailedTurns: unknown[] };
  const [withRetry, withoutRetry] = raw.botSessionFailedTurns.map(parseAidenRemoteBotSessionEntry);
  assert.deepEqual(withRetry, raw.botSessionFailedTurns[0]);
  assert.equal(withRetry?.type === "failed_turn" && withRetry.retryText, "Plan my week, please.");
  assert.deepEqual(withoutRetry, { type: "failed_turn", id: "entry_16:failed" });
  for (const invalid of [
    { type: "failed_turn", id: "entry_1:failed", retryText: "" },
    { type: "failed_turn", id: "entry_1:failed", errorMessage: "provider down" },
    { type: "failed_turn", id: "entry 1" },
  ]) {
    assert.throws(() => parseAidenRemoteBotSessionEntry(invalid));
  }
});

test("Bot sessions carry the waiting approval, and approval frames parse strictly", async () => {
  const raw = (await json("fixtures/contract.json")) as { botSession: Record<string, unknown>; botSessionEvents: unknown[] };
  const events = raw.botSessionEvents.map(parseAidenRemoteBotSessionEvent);
  assert.deepEqual(events, raw.botSessionEvents, "every fixture frame round-trips");
  const approvals = events.flatMap((event) => (event.type === "approval" ? [event.payload.approval] : []));
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0]?.canAllow, true);
  assert.equal(approvals[1], null, "a settled approval clears");

  const waiting = approvals[0]!;
  assert.deepEqual(parseAidenRemoteBotSession({ ...raw.botSession, approval: waiting }).approval, waiting);
  const { approval: _approval, ...missing } = raw.botSession;
  assert.throws(() => parseAidenRemoteBotSession(missing), /approval is required/u);
  for (const invalid of [
    { ...waiting, scopes: ["once"] },
    { ...waiting, canAllow: "yes" },
    { ...waiting, waitId: "wait id" },
    { ...waiting, summary: "" },
  ]) {
    assert.throws(() => parseAidenRemoteBotSession({ ...raw.botSession, approval: invalid }));
  }
});

test("the shared Bot avatar palette fixture is exactly the desktop colour table", async () => {
  const raw = (await json("fixtures/contract.json")) as { botAvatarPalette?: unknown };
  // iOS and Android test their palettes against this same fixture.
  assert.deepEqual(raw.botAvatarPalette, { face: BOT_AVATAR_FACE_HEX, colors: BOT_AVATAR_COLOR_HEX });
  assert.deepEqual(Object.keys(BOT_AVATAR_COLOR_HEX), [...BOT_AVATAR_COLORS]);
  for (const value of [BOT_AVATAR_FACE_HEX, ...Object.values(BOT_AVATAR_COLOR_HEX)]) {
    assert.match(value, /^#[0-9A-F]{6}$/u);
  }
});

test("Bot attachment references arrive in revision 33 and only where the host announces them", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const section = parseAidenRemoteContractFixture(raw).botAttachments!;
  assert.deepEqual(section.send.request.attachmentIds, raw.botAttachments.send.request.attachmentIds);
  assert.equal(section.attachmentsOnly.text, "", "attachments make the words optional");
  assert.throws(
    () => parseAidenRemoteBotMessageRequest(raw.botAttachments.send.request, { allowWhenBusy: true }),
    /unsupported field attachmentIds/u,
  );
  for (const sample of raw.botAttachments.rejectedSends) {
    assert.throws(() => parseAidenRemoteBotMessageRequest(sample, { allowAttachments: true }), Error, JSON.stringify(sample));
  }
  const older = structuredClone(raw);
  older.contractRevision = 32;
  record(older.hostHealth, "hostHealth").contractRevision = 32;
  assert.throws(() => parseAidenRemoteContractFixture(older), /require contract revision 33/u);
});

// ---------------------------------------------------------------------------
// Contract revision 30: Bot chat activity on phones
// ---------------------------------------------------------------------------

test("Bot activity frames carry only the §11 allow-list, and every privacy sample is refused", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const fixture = parseAidenRemoteContractFixture(raw);
  const section = fixture.botActivity!;
  assert.deepEqual(section.session, raw.botActivity.session, "the activity session round-trips");
  assert.deepEqual(section.events, raw.botActivity.events, "every activity frame round-trips");
  const shown = [section.session.activity, ...section.events.flatMap((event) => (event.type === "activity" ? [event.payload.activity] : []))];
  for (const activity of shown) {
    if (activity === null || activity === undefined) continue;
    assert.deepEqual(Object.keys(activity).filter((key) => !["phase", "app", "startedAt"].includes(key)), []);
  }
  for (const sample of raw.botActivityPrivacy.rejectedActivities) {
    assert.throws(() => parseAidenRemoteBotSessionActivity(sample), Error, JSON.stringify(sample));
    const frame = { ...raw.botActivity.events[0], payload: { activity: sample } };
    assert.throws(() => parseAidenRemoteBotSessionEvent(frame), Error, JSON.stringify(sample));
  }
  // A few samples are pinned to their reason, so a TypeError can never pass for a refusal.
  const refusedWith = (field: string, pattern: RegExp) => {
    const sample = raw.botActivityPrivacy.rejectedActivities.find((candidate: Record<string, unknown>) => field in candidate);
    assert.throws(() => parseAidenRemoteBotSessionActivity(sample), pattern, field);
  };
  refusedWith("detail", /unsupported field detail/u);
  refusedWith("step", /unsupported field step/u);
  refusedWith("query", /unsupported field query/u);
  for (const sample of raw.botActivityPrivacy.rejectedQueued) {
    assert.throws(() => parseAidenRemoteBotSession({ ...raw.botActivity.session, queued: [sample] }), Error, JSON.stringify(sample));
  }
  const [duplicateIds, twentyOneItems] = raw.botActivityPrivacy.rejectedQueuedLists;
  assert.equal(duplicateIds.length, 2);
  assert.equal(twentyOneItems.length, 21);
  assert.throws(() => parseAidenRemoteBotSession({ ...raw.botActivity.session, queued: duplicateIds }), /ids must be unique/u);
  assert.throws(() => parseAidenRemoteBotSession({ ...raw.botActivity.session, queued: twentyOneItems }), /at most 20/u);
  assert.throws(() => parseAidenRemoteBotSession({ ...raw.botActivity.session, queued: "not a list" }), /must be an array/u);
  const repeated = ({ unit, count }: { unit: string; count: number }) => unit.repeat(count);
  const bounds = raw.botActivityPrivacy.textBounds;
  const queuedWith = (text: string) => ({ ...raw.botActivity.session, queued: [{ submissionId: "18", mode: "queue", text }] });
  for (const sample of bounds.queuedText.rejected) {
    assert.throws(() => parseAidenRemoteBotSession(queuedWith(repeated(sample))), /characters/u, `${sample.count} x ${sample.unit}`);
  }
  for (const sample of bounds.queuedText.accepted) {
    assert.equal(parseAidenRemoteBotSession(queuedWith(repeated(sample))).queued![0]!.text, repeated(sample));
  }
  const appWith = (app: string) => ({ phase: "app", app, startedAt: 1_760_450_000_000 });
  for (const sample of bounds.app.rejected) {
    assert.throws(() => parseAidenRemoteBotSessionActivity(appWith(repeated(sample))), /characters/u, `${sample.count} x ${sample.unit}`);
  }
  for (const sample of bounds.app.accepted) {
    assert.equal(parseAidenRemoteBotSessionActivity(appWith(repeated(sample))).app, repeated(sample));
  }
  for (const sample of raw.botActivityPrivacy.rejectedChatActivity) {
    assert.throws(() => parseAidenRemoteBotDetail({ ...raw.botActivity.detail, chatActivity: sample }), Error, JSON.stringify(sample));
    assert.throws(() => parseAidenRemoteBotIdentityPatchRequest({ chatActivity: sample }, { allowChatActivity: true }));
  }
});

test("an optional Bot activity key sent as the literal null is refused, never read as absent", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const { activities, sessions, events, entries } = raw.botActivityPrivacy.rejectedNullLiterals;
  assert.deepEqual(activities.map((sample: Record<string, unknown>) => sample.app), [null]);
  assert.deepEqual(sessions.map((sample: Record<string, unknown>) => sample.queued), [null]);
  assert.deepEqual(events.map((sample: Record<string, any>) => sample.payload.queued), [null]);
  assert.deepEqual(entries.map((sample: Record<string, unknown>) => [sample.label, sample.submissionId]), [[null, "17"]]);
  for (const sample of activities) {
    assert.throws(() => parseAidenRemoteBotSessionActivity(sample), /app must be/u, JSON.stringify(sample));
    const { app: _app, ...withoutApp } = sample;
    assert.deepEqual(parseAidenRemoteBotSessionActivity(withoutApp), withoutApp, "the same activity without the key is fine");
  }
  for (const sample of sessions) {
    assert.throws(() => parseAidenRemoteBotSession(sample), /queued messages must be an array/u);
    const { queued: _queued, ...withoutQueued } = sample;
    assert.equal("queued" in parseAidenRemoteBotSession(withoutQueued), false, "an absent list stays absent");
  }
  for (const sample of events) {
    assert.throws(() => parseAidenRemoteBotSessionEvent(sample), /queued messages must be an array/u);
  }
  for (const sample of entries) {
    assert.throws(() => parseAidenRemoteBotSessionEntry(sample), /Only the person's message can carry a submissionId/u);
    const { label: _label, ...withoutLabel } = sample;
    const entry = parseAidenRemoteBotSessionEntry(withoutLabel);
    assert.equal(entry.type === "message" && entry.submissionId, "17", "the same bubble without the key keeps its id");
  }
});

test("the person's own message carries its submissionId for bot:activity devices only, and every misuse is refused", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const fixture = parseAidenRemoteContractFixture(raw);
  const section = fixture.botActivity!;
  const sent = section.session.entries[0]!;
  assert.equal(sent.type === "message" && sent.role === "user" && sent.submissionId, "17");
  // The queued message 18 was placed in the turn: its bubble now carries the same id.
  assert.deepEqual(section.entryEvent, raw.botActivity.entryEvent, "the entry frame round-trips");
  const placed = section.entryEvent.type === "entry" ? section.entryEvent.payload.entry : undefined;
  assert.equal(placed?.type === "message" && placed.submissionId, raw.botActivity.session.queued[0].submissionId);

  // What a device without bot:activity is sent for the same session and frame: no new key anywhere.
  const { nonHolder } = raw.botActivityPrivacy;
  const legacy = parseAidenRemoteBotSession(nonHolder.session);
  const legacyFrame = parseAidenRemoteBotSessionEvent(nonHolder.entryEvent);
  for (const value of [legacy, legacyFrame]) {
    assert.equal(JSON.stringify(value).includes("submissionId"), false);
  }
  assert.equal("activity" in legacy || "queued" in legacy, false);
  const withoutId = (entry: Record<string, unknown>) => {
    const { submissionId: _submissionId, ...rest } = entry;
    return rest;
  };
  assert.deepEqual(legacy.entries, raw.botActivity.session.entries.map(withoutId), "the same messages, without their ids");
  assert.equal(legacyFrame.seq, raw.botActivity.entryEvent.seq, "the same seq");
  assert.deepEqual(nonHolder.entryEvent.payload.entry, withoutId(raw.botActivity.entryEvent.payload.entry));

  for (const sample of raw.botActivityPrivacy.rejectedSubmissionIdEntries) {
    assert.throws(() => parseAidenRemoteBotSessionEntry(sample), Error, JSON.stringify(sample));
  }
  const [assistantWithId, routineWithId] = raw.botActivityPrivacy.rejectedSubmissionIdEntries;
  assert.throws(() => parseAidenRemoteBotSessionEntry(assistantWithId), /Only the person's message can carry a submissionId/u);
  assert.equal(routineWithId.label, "Morning brief", "a routine's input");
  assert.throws(() => parseAidenRemoteBotSessionEntry(routineWithId), /Only the person's message can carry a submissionId/u);
  const { submissionId: _routineId, ...routine } = routineWithId;
  assert.deepEqual(parseAidenRemoteBotSessionEntry(routine), routine, "the same routine bubble without an id is fine");
});

test("whenBusy and chatActivity are refused unless the host wires bot-activity-v1", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const send = raw.botActivity.send.request;
  assert.throws(() => parseAidenRemoteBotMessageRequest(send), /unsupported field whenBusy/u);
  assert.deepEqual(parseAidenRemoteBotMessageRequest(send, { allowWhenBusy: true }), send);
  assert.deepEqual(parseAidenRemoteBotMessageRequest({ text: "Hi" }, { allowWhenBusy: true }), { text: "Hi" });
  assert.throws(() => parseAidenRemoteBotMessageRequest({ text: "Hi", whenBusy: "followUp" }, { allowWhenBusy: true }));
  const patch = raw.botActivity.identityPatch.request;
  assert.throws(() => parseAidenRemoteBotIdentityPatchRequest(patch), /unsupported field chatActivity/u);
  assert.deepEqual(parseAidenRemoteBotIdentityPatchRequest(patch, { allowChatActivity: true }), patch);
});

test("the shared phase table is the one the Mac draws, and an unknown phase reads as Working", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const { phases, thinkingKeeps, app, elapsed } = raw.botActivity as {
    phases: Array<{ id: string; word: string; mark: string }>;
    thinkingKeeps: string[];
    app: { app: string; word: string };
    elapsed: Array<{ startedAt: number; now: number; label: string | null }>;
  };
  assert.deepEqual(phases.map((phase) => phase.id), [...BOT_ACTIVITY_PHASES]);
  for (const phase of phases) {
    assert.deepEqual(botActivityDisplay(phase.id, "follows"), { phase: phase.id, word: phase.word, mark: phase.mark });
    assert.equal(botActivityDisplay(phase.id, "thinking").phase, thinkingKeeps.includes(phase.id) ? phase.id : "thinking");
  }
  assert.equal(botActivityDisplay("app", "follows", app.app).word, app.word);
  assert.deepEqual(botActivityDisplay("teleporting", "follows"), botActivityDisplay("working", "follows"));
  for (const row of elapsed) assert.equal(botElapsedLabel(row.startedAt, row.now), row.label, JSON.stringify(row));
});

// ---------------------------------------------------------------------------
// Contract revision 37: Bot hand-offs and pause on phones
// ---------------------------------------------------------------------------

test("hand-off frames and pause round-trip for holders, and a legacy device never sees a revision-37 word", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const section = parseAidenRemoteContractFixture(raw).botHandoffs!;
  assert.equal(section.capability, "bot:handoffs");
  assert.deepEqual(section.session, raw.botHandoffs.session, "the waiting session round-trips");
  assert.deepEqual(section.events, raw.botHandoffs.events, "every holder frame round-trips");
  assert.deepEqual(section.legacy.events, raw.botHandoffs.legacy.events, "every legacy frame round-trips");
  assert.deepEqual(section.pausedSummary, raw.botHandoffs.pausedSummary);
  assert.deepEqual(section.pausedDetail, raw.botHandoffs.pausedDetail);

  // The card opens and then settles; every route answers for the same wait.
  const cards = section.events.flatMap((event) => (event.type === "handoff" ? [event.payload.handoff] : []));
  assert.deepEqual(cards, [section.session.handoff, null]);
  const waitId = section.session.handoff!.waitId;
  assert.equal(section.answer.response.waitId, waitId);
  assert.equal(section.openOnMac.response.waitId, waitId);
  assert.deepEqual(section.pause.response, { state: "paused", interrupted: false });
  assert.equal(section.unpause.response.state, "idle");

  // Both audiences read the same gapless sequence, so a resume cursor works
  // the same way whichever view a device holds.
  const seqs = (events: Array<{ seq: number }>) => events.map((event) => event.seq);
  assert.deepEqual(seqs(section.legacy.events), seqs(section.events));
  assert.deepEqual(seqs(section.events), [41, 42, 43, 44]);
  // The answer is the person's own message, the same entry for both views.
  const answerEntry = (events: typeof section.events) =>
    events.find((event) => event.type === "entry" && event.payload.entry.id === "entry_handoff:call_fixture_36");
  assert.deepEqual(answerEntry(section.legacy.events), answerEntry(section.events));

  // A legacy device reads the hand-off as one assistant line and a pause as unavailable.
  const legacyText = JSON.stringify(raw.botHandoffs.legacy);
  assert.doesNotMatch(legacyText, /"handoff"|"paused"|bot_paused/u);
  const notice = section.legacy.session.entries[section.legacy.session.entries.length - 1]!;
  assert.equal(notice.type === "message" && notice.role, "assistant");
  assert.equal(notice.id, `handoff-notice:${waitId}`);
  assert.equal(section.legacy.pausedSession.state, "unavailable");
  assert.equal(section.legacy.pausedSummary.sessionState, "unavailable");
  assert.equal(section.pausedError.error.message, section.legacy.pausedError.error.message);
});

test("hand-off, answer and paused-flag parsers refuse what a closed decoder would refuse", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const card = raw.botHandoffs.session.handoff as Record<string, unknown>;
  assert.deepEqual(parseAidenRemoteBotHandoff(card), card);
  const { why: _why, open: _open, ...bare } = card;
  assert.deepEqual(parseAidenRemoteBotHandoff({ ...bare, kind: "sign_in" }), { ...bare, kind: "sign_in" });
  for (const invalid of [
    { ...card, extra: true },
    { ...card, kind: "payment" },
    { ...card, waitId: "wait id" },
    { ...card, action: "   " },
    { ...card, action: "x".repeat(161) },
    { ...card, open: { url: "http://bank.example.com/verify" } },
    { ...card, open: { url: "javascript:alert(1)" } },
    { ...card, open: { url: "https://bank.example.com", target: "_blank" } },
  ]) {
    assert.throws(() => parseAidenRemoteBotHandoff(invalid), Error, JSON.stringify(invalid));
  }

  assert.deepEqual(parseAidenRemoteBotHandoffAnswerRequest({ outcome: "skipped" }), { outcome: "skipped" });
  for (const invalid of [
    { outcome: "later" },
    { outcome: "done", note: "  " },
    { outcome: "done", note: "x".repeat(4_001) },
    { outcome: "done", waitId: card.waitId },
    {},
  ]) {
    assert.throws(() => parseAidenRemoteBotHandoffAnswerRequest(invalid), Error, JSON.stringify(invalid));
  }
  assert.throws(() => parseAidenRemoteBotHandoffOpenOnMacReceipt({ waitId: card.waitId, opened: "yes" }));

  // `paused` and the `paused` session state always travel together; a summary sends the flag only as true.
  const summary = raw.botHandoffs.pausedSummary as Record<string, unknown>;
  assert.throws(() => parseAidenRemoteBotSummary({ ...summary, paused: false }), /must be true/u);
  assert.throws(() => parseAidenRemoteBotSummary({ ...summary, sessionState: "idle" }), /agree/u);
  const { paused: _flag, ...unflagged } = summary;
  assert.throws(() => parseAidenRemoteBotSummary(unflagged), /agree/u);
  const detail = raw.botHandoffs.pausedDetail as Record<string, unknown>;
  assert.equal(parseAidenRemoteBotDetail({ ...detail, sessionState: "idle", paused: false }).paused, false);
  assert.throws(() => parseAidenRemoteBotDetail({ ...detail, paused: false }), /agree/u);
  assert.throws(() => parseAidenRemoteBotDetail({ ...detail, sessionState: "running" }), /agree/u);

  // A session's hand-off is nullable and closed; a frame carries it wrapped.
  assert.throws(() => parseAidenRemoteBotSession({ ...raw.botHandoffs.session, handoff: { ...card, extra: 1 } }));
  const [opened] = raw.botHandoffs.events as Array<Record<string, any>>;
  assert.throws(() => parseAidenRemoteBotSessionEvent({ ...opened, payload: card }));
  assert.throws(() => parseAidenRemoteBotSessionEvent({ ...opened, payload: { handoff: card, approval: null } }));
});

test("Bot hand-off fixtures require their own revision, and an older fixture parses without them", async () => {
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const older = structuredClone(raw);
  older.contractRevision = AIDEN_REMOTE_BOT_HANDOFFS_CONTRACT_REVISION - 1;
  record(older.hostHealth, "hostHealth").contractRevision = AIDEN_REMOTE_BOT_HANDOFFS_CONTRACT_REVISION - 1;
  // The number is re-claimed at merge, so the test names it only through the constant.
  assert.throws(
    () => parseAidenRemoteContractFixture(older),
    new RegExp(`require contract revision ${AIDEN_REMOTE_BOT_HANDOFFS_CONTRACT_REVISION}\\b`, "u"),
  );
  delete older.botHandoffs;
  assert.equal(parseAidenRemoteContractFixture(older).botHandoffs, undefined);

  // The fixture guards its own invariants: a legacy view may not leak a holder word.
  const leaky = structuredClone(raw);
  leaky.botHandoffs.legacy.pausedSummary = raw.botHandoffs.pausedSummary;
  assert.throws(() => parseAidenRemoteContractFixture(leaky), /must not carry paused/u);
  const leakySnapshot = structuredClone(raw);
  const settled = leakySnapshot.botHandoffs.legacy.events.find((event: { type: string }) => event.type === "snapshot");
  settled.payload.session.handoff = null;
  assert.throws(() => parseAidenRemoteContractFixture(leakySnapshot), /must not carry hand-off or paused/u);
  const wrongCode = structuredClone(raw);
  wrongCode.botHandoffs.legacy.pausedError.error.code = "bot_paused";
  assert.throws(() => parseAidenRemoteContractFixture(wrongCode), /operation_stale/u);
});

test("Bot hand-off OpenAPI schemas accept the shared fixture and refuse what the parsers refuse", async () => {
  const { default: Ajv2020 } = await import("ajv/dist/2020.js");
  const spec = await json("openapi.json") as { components: { schemas: Record<string, object> } };
  const raw = (await json("fixtures/contract.json")) as Record<string, any>;
  const section = raw.botHandoffs;
  const ajv = new Ajv2020({ strict: false });
  const schema = (name: string) => ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  // BotSession composes BotSessionState with allOf, which plain JSON Schema
  // validators read as closed, so the session's hand-off is checked on its own.
  const handoff = schema("BotHandoff");
  const event = schema("BotSessionEvent");
  const state = schema("BotSessionState");
  const summary = schema("BotSummary");
  const detail = schema("BotDetail");
  const answer = schema("BotHandoffAnswerRequest");
  const error = schema("ErrorEnvelope");
  for (const [validate, sample, label] of [
    [handoff, section.session.handoff, "session hand-off"],
    [handoff, section.events[0].payload.handoff, "hand-off frame"],
    [answer, section.answer.request, "answer"],
    [schema("BotHandoffAnswerReceipt"), section.answer.response, "answer receipt"],
    [schema("BotHandoffOpenOnMacReceipt"), section.openOnMac.response, "open-on-Mac receipt"],
    [state, section.pause.response, "pause"],
    [state, section.unpause.response, "unpause"],
    [summary, section.pausedSummary, "paused summary"],
    [summary, section.legacy.pausedSummary, "legacy paused summary"],
    [detail, section.pausedDetail, "paused detail"],
    [error, section.pausedError, "paused error"],
    [error, section.legacy.pausedError, "legacy paused error"],
  ] as const) {
    assert.equal(validate(sample), true, `${label}: ${JSON.stringify(validate.errors)}`);
  }
  for (const frame of [...section.events, ...section.legacy.events]) {
    assert.equal(event(frame), true, `${frame.type} ${frame.seq}: ${JSON.stringify(event.errors)}`);
  }
  assert.equal(answer({ outcome: "later" }), false);
  assert.equal(answer({ outcome: "done", note: "" }), false);
  assert.equal(summary({ ...section.pausedSummary, paused: false }), false);
  assert.equal(handoff({ ...section.session.handoff, extra: true }), false);
  assert.equal(handoff({ ...section.session.handoff, open: { url: "http://bank.example.com" } }), false);
});
