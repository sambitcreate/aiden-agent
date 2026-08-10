import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createChatStore } from "./chat-store-core.js";
import { chatMessageToPiMessage } from "./generation-messages.js";
import { SkillRegistry } from "./skill-registry.js";
import {
  commitSkillInvocationForAppend,
  preparedSkillPromptForCurrentTurn,
  type PreparedSkillInvocation,
} from "./skill-invocation-turn.js";
import { ChatTurnAdmission } from "./chat-turn-admission.js";
import type { DiscoveredSkill, Workspace } from "./types.js";

test("the production skill turn commits safe provenance and injects private instructions once", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-skill-flow-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workspace: Workspace = {
    id: "workspace-a",
    name: "Workspace A",
    folderPath: "/trusted/workspace-a",
    permission: "ask",
    createdAt: 1,
    updatedAt: 1,
  };
  const secret = "PRIVATE_SKILL_INSTRUCTIONS_9b27";
  const privatePath = "/trusted/workspace-a/.agents/review/SKILL.md";
  let discovered: DiscoveredSkill[] = [
    {
      id: `workspace:${privatePath}`,
      name: "Review",
      description: "Review a change",
      instructions: secret,
      source: "workspace",
      path: privatePath,
    },
  ];
  const registry = new SkillRegistry({
    getWorkspace: async (id) => (id === workspace.id ? workspace : undefined),
    listConfigured: async () => [],
    discover: async () => structuredClone(discovered),
    now: () => 1,
    invocationKey: new Uint8Array(32).fill(19),
    cacheTtlMs: 60_000,
    cacheLimit: 4,
  });
  const catalog = await registry.snapshot(workspace.id);
  const invocation = catalog.catalog.find((entry) => entry.available);
  assert.ok(invocation);

  const store = createChatStore(async () => directory);
  const chat = await store.create({ workspaceId: workspace.id });
  const admission = new ChatTurnAdmission();
  const lease = admission.tryBegin(chat.id, "turn-a", "owner-a", false);
  assert.ok(lease);
  lease.reserveSkillPreparation();
  const committed = await commitSkillInvocationForAppend(
    {
      invocationId: invocation.invocationId,
      role: "user",
      content: "Check this patch.",
      attachments: undefined,
      workspaceId: workspace.id,
      userMessageId: "message-a",
    },
    {
      resolveFresh: (workspaceId, invocationId) => registry.resolveFresh(workspaceId, invocationId),
      isCurrent: lease.isActive,
      prepareLease: lease.prepareSkillInvocation,
      append: (prepared) =>
        store.appendMessage(
          chat.id,
          {
            id: prepared.userMessageId,
            role: "user",
            content: "Check this patch.",
            skill: prepared.provenance,
          },
          { expectedWorkspaceId: workspace.id, isCurrent: lease.isActive },
        ),
    },
  );
  const currentUser = committed.messages[committed.messages.length - 1];
  assert.equal(currentUser?.id, "message-a");
  assert.deepEqual(currentUser?.skill, { version: 1, name: "Review", source: "workspace" });

  const persisted = await fs.readFile(path.join(directory, `${chat.id}.json`), "utf8");
  assert.doesNotMatch(persisted, new RegExp(`${secret}|${privatePath}|invocationId`, "u"));
  const persistedChat = JSON.parse(persisted) as {
    messages: Array<{ skill?: { version: number; name: string; source: string } }>;
  };
  assert.deepEqual(persistedChat.messages[0]?.skill, {
    version: 1,
    name: "Review",
    source: "workspace",
  });

  lease.settleAsyncWork();

  let handedOff: PreparedSkillInvocation | undefined;
  assert.equal(
    admission.handoff(chat.id, "turn-a", "owner-a", (prepared) => {
      handedOff = prepared;
    }),
    true,
  );
  assert.ok(handedOff);
  const currentPrompt = preparedSkillPromptForCurrentTurn(
    handedOff,
    workspace.id,
    currentUser,
    undefined,
  );
  const model = {
    api: "openai-completions",
    provider: "test-provider",
    id: "test-model",
  } as Model<Api>;
  const currentPiMessage = chatMessageToPiMessage(currentUser!, model, false, currentPrompt);
  assert.match(JSON.stringify(currentPiMessage), new RegExp(secret, "u"));
  assert.match(JSON.stringify(currentPiMessage), /Check this patch\./u);
  assert.doesNotMatch(
    JSON.stringify(chatMessageToPiMessage(currentUser!, model, false)),
    new RegExp(secret, "u"),
  );
  assert.equal(
    admission.handoff(chat.id, "turn-a", "owner-a", () => undefined),
    false,
  );

  discovered = [{ ...discovered[0]!, instructions: "Changed private instructions." }];
  const messageCount = (await store.get(chat.id))!.messages.length;
  let staleAppendCalled = false;
  await assert.rejects(
    commitSkillInvocationForAppend(
      {
        invocationId: invocation.invocationId,
        role: "user",
        content: "Try the stale reference.",
        attachments: undefined,
        workspaceId: workspace.id,
        userMessageId: "message-stale",
      },
      {
        resolveFresh: (workspaceId, invocationId) =>
          registry.resolveFresh(workspaceId, invocationId),
        isCurrent: () => true,
        prepareLease: () => undefined,
        append: async () => {
          staleAppendCalled = true;
        },
      },
    ),
    /expired or changed/u,
  );
  assert.equal(staleAppendCalled, false);
  assert.equal((await store.get(chat.id))!.messages.length, messageCount);
});
