import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import { projectAidenRemoteChat } from "./aiden-remote-chats.js";
import { projectAidenRemoteWorkspace } from "./aiden-remote-workspaces.js";
import { PeerTransportError, type PeerRequest } from "./peer-transport.js";
import { CAPABILITIES, FakeHost, FEATURES, UNHANDLED, setup } from "./peer-remote-chat-test-host.js";
import type { Workspace } from "./types.js";
import type { Chat, ChatMessage } from "../../renderer/lib/types.js";
import { HostChatControlError, isOutcomeUnknown } from "../../renderer/lib/hosts/host-chat-adapter.js";
import { defaultHostModel } from "../../renderer/lib/hosts/host-resources.js";
import { remoteAttachmentUploads } from "../../renderer/lib/hosts/remote-attachments.js";
import { RemoteNewChatControl } from "../../renderer/lib/hosts/remote-new-chat.js";

/**
 * Starting work on another Mac end to end: the new-chat control over the
 * renderer adapter, main's real live IPC handlers, operation encoding,
 * response contract validation and host supervisor, against a host that
 * keeps its projects, chats, staged uploads and Bot chats behind the real
 * idempotency ledger and projections. Only the network and Electron's IPC
 * are stand-ins.
 */

const NOW = new Date(5_000).toISOString();
const token = (prefix: string, n: number) => `${prefix}_${String(n).padStart(43, "0")}`;
const ROOT = token("loc", 1);
const LAUNCH = token("loc", 2);

function code(expected: string) {
  return (error: unknown) => error instanceof HostChatControlError && error.code === expected;
}

/** Host B: one existing project, an approved folder to browse, and a Bot. */
class StudioHost {
  readonly host = new FakeHost("host_b", []);
  readonly workspaces = new Map<string, Workspace>([
    ["ws-site", { id: "ws-site", name: "Site", folderPath: "/Users/b/site", permission: "ask", createdAt: 1, updatedAt: 2 }],
  ]);
  readonly chats = new Map<string, Chat>();
  readonly staged = new Map<string, { chatId: string; name: string }>();
  readonly turns: Array<{ chatId: string; text: string; attachments: string[] }> = [];
  readonly selections = new Map<string, string>();
  readonly botChats = new Map<string, string>();
  /** Answers to lose after the host applied the request, as a dropped connection would. */
  readonly drop = { create: 0, turn: 0, workspace: 0 };
  private minted = 0;

  constructor() {
    this.host.capabilities = [...CAPABILITIES, "workspace:read", "workspace:browse", "workspace:manage", "bot:read", "bot:write"];
    this.host.features = [...FEATURES];
    this.host.routes = (input, deviceId) => this.answer(input, deviceId);
  }

  /** Every request this Mac sent to the host after `from`, minus the supervisor's own. */
  requests(from = 0): string[] {
    return this.host.calls.slice(from).filter((call) => !/^(GET \/server|GET \/device\/capabilities|EVENTS )/u.test(call));
  }

  private lose(step: keyof StudioHost["drop"]): void {
    if (this.drop[step] > 0) {
      this.drop[step] -= 1;
      throw new PeerTransportError("unavailable");
    }
  }

  private async answer(input: PeerRequest, deviceId: string): Promise<unknown> {
    const url = new URL(input.path, "https://host.invalid");
    const method = input.method ?? "GET";
    const key = input.idempotencyKey ?? "";
    const body = (input.body ?? {}) as Record<string, unknown>;
    if (url.pathname === "/models" && method === "GET") {
      return {
        providers: [
          {
            id: "prov-b",
            label: "Studio provider",
            models: [
              { id: "model-hidden", label: "Retired", supportsImages: false, hidden: true },
              { id: "model-b", label: "Studio model", supportsImages: true },
            ],
          },
        ],
        defaults: { providerId: "prov-b", modelId: "model-b" },
      };
    }
    if (url.pathname === "/workspace-browser/roots" && method === "GET") {
      return { roots: [{ id: "root-1", label: "Projects", location: ROOT, policyRevision: "p1" }] };
    }
    if (url.pathname === "/workspace-browser/children" && method === "GET") {
      if (url.searchParams.get("location") !== ROOT) throw new AidenRemoteServiceError("not_found", "No such folder.", 404);
      return {
        rootId: "root-1",
        label: "Projects",
        breadcrumbs: [{ label: "Projects", location: ROOT }],
        entries: [{ id: "e-launch", name: "launch", location: LAUNCH }],
      };
    }
    if (url.pathname === "/workspace-browser/selections" && method === "POST") {
      const selection = token("sel", ++this.minted);
      this.selections.set(selection, String(body.location));
      return { selection, displayName: "launch", expiresAt: NOW };
    }
    if (url.pathname === "/workspaces" && method === "POST") {
      const workspace = await this.host.idempotent(
        { deviceId, route: "POST /workspaces", resourceId: "workspaces", key },
        body,
        async () => {
          let name = "Scratch";
          if (body.mode === "selected-folder") {
            // A selection names one browsed folder, once.
            const location = this.selections.get(String(body.selection));
            if (location !== LAUNCH) throw new AidenRemoteServiceError("invalid_request", "That folder selection expired.", 400);
            this.selections.delete(String(body.selection));
            name = "launch";
          }
          const id = `ws-${this.workspaces.size + 1}`;
          const created: Workspace = { id, name, permission: "ask", createdAt: 3, updatedAt: 3, ...(body.mode === "selected-folder" ? { folderPath: "/Users/b/Projects/launch" } : {}) };
          this.workspaces.set(id, created);
          return projectAidenRemoteWorkspace(created);
        },
      );
      this.lose("workspace");
      return workspace;
    }
    if (url.pathname === "/chats" && method === "POST") {
      const projection = await this.host.idempotent(
        { deviceId, route: "POST /chats", resourceId: "chats", key },
        body,
        async () => {
          const workspaceId = String(body.workspaceId);
          if (!this.workspaces.has(workspaceId)) throw new AidenRemoteServiceError("not_found", "No such project.", 404);
          return this.project(this.create(workspaceId, body));
        },
      );
      this.lose("create");
      return projection;
    }
    const bot = /^\/bots\/([^/]+)\/chats$/u.exec(url.pathname);
    if (bot && method === "POST") {
      const botId = decodeURIComponent(bot[1]!);
      return this.host.idempotent({ deviceId, route: "POST /bots/{id}/chats", resourceId: botId, key }, body, async () => {
        // A Bot has one chat; asking again returns it.
        const existing = this.botChats.get(botId);
        const chat = existing ? this.chats.get(existing)! : this.create("ws-bots", {}, botId);
        this.botChats.set(botId, chat.id);
        return this.project(chat);
      });
    }
    const chat = /^\/chats\/(new-[0-9]+)(\/attachments|\/turns)?$/u.exec(url.pathname);
    if (!chat) return UNHANDLED;
    const chatId = chat[1]!;
    const current = this.chats.get(chatId);
    if (!current) throw new AidenRemoteServiceError("not_found", "No such chat.", 404);
    if (!chat[2] && method === "GET") return this.project(current);
    if (chat[2] === "/attachments" && method === "POST") {
      const id = token("att", ++this.minted);
      this.staged.set(id, { chatId, name: String(body.name) });
      return { id, name: String(body.name), mimeType: String(body.mimeType), kind: body.kind, size: String(body.text ?? body.data ?? "").length, expiresAt: NOW };
    }
    if (chat[2] === "/turns" && method === "POST") {
      const receipt = await this.host.idempotent(
        { deviceId, route: "POST /chats/{id}/turns", resourceId: chatId, key },
        body,
        async () => {
          const attachments = (body.attachmentIds as string[] | undefined) ?? [];
          for (const id of attachments) {
            if (this.staged.get(id)?.chatId !== chatId) throw new AidenRemoteServiceError("invalid_request", "That upload is gone.", 400);
          }
          // A turn consumes the uploads it names.
          for (const id of attachments) this.staged.delete(id);
          const turn = this.turns.push({ chatId, text: String(body.text), attachments });
          const message: ChatMessage = { id: `${chatId}-m${turn}`, role: "user", content: String(body.text), createdAt: 4_000 + turn };
          this.chats.set(chatId, { ...current, messages: [...current.messages, message], updatedAt: current.updatedAt + 1 });
          return {
            turnId: `turn_${turn}`,
            streamId: `stream_${turn}`,
            status: "accepted" as const,
            message: projectAidenRemoteChat({ ...current, messages: [message] }).messages[0]!,
          };
        },
      );
      this.lose("turn");
      return receipt;
    }
    return UNHANDLED;
  }

  private create(workspaceId: string, body: Record<string, unknown>, botId?: string): Chat {
    const id = `new-${this.chats.size + 1}`;
    const created: Chat = {
      id,
      title: "",
      workspaceId,
      createdAt: 3_000,
      updatedAt: 3_000,
      messages: [],
      ...(typeof body.providerId === "string" && typeof body.modelId === "string"
        ? { providerId: body.providerId, model: body.modelId }
        : {}),
      ...(botId ? { botId } : {}),
    };
    this.chats.set(id, created);
    return created;
  }

  private project(chat: Chat): unknown {
    return JSON.parse(JSON.stringify(projectAidenRemoteChat(chat)));
  }
}

async function start(studio: StudioHost) {
  const harness = await setup(studio.host);
  const control = new RemoteNewChatControl(harness.adapter);
  control.attach();
  return { harness, control };
}

test("a new chat on B starts in B's project with B's model, and its attachments are staged and used there", async () => {
  const studio = new StudioHost();
  const { harness, control } = await start(studio);
  try {
    const from = studio.host.calls.length;
    const models = await harness.adapter.models();
    assert.ok(models.ok);
    const model = defaultHostModel(models.value);
    assert.deepEqual(model, { providerId: "prov-b", modelId: "model-b" }, "B's own default, never a hidden model");

    const uploads = remoteAttachmentUploads([
      { id: "local-1", kind: "text", name: "brief.md", mimeType: "text/markdown", size: 12, text: "# Launch plan" },
    ]);
    const started = await control.start({ workspaceId: "ws-site", model: model! }, "Plan the launch", uploads);

    const chat = studio.chats.get(started.chatId);
    assert.equal(chat?.workspaceId, "ws-site", "the chat lives in B's project");
    assert.equal(chat?.providerId, "prov-b");
    assert.equal(chat?.model, "model-b");
    assert.equal(studio.turns.length, 1);
    assert.equal(studio.turns[0]?.text, "Plan the launch");
    assert.equal(studio.turns[0]?.attachments.length, 1, "the first message carries the upload");
    assert.equal(studio.staged.size, 0, "the turn used the staged upload");
    assert.deepEqual(studio.requests(from), [
      "GET /models",
      "POST /chats",
      `POST /chats/${started.chatId}/attachments`,
      `POST /chats/${started.chatId}/turns`,
    ]);
    assert.equal(control.getSnapshot().unresolved, null);
  } finally {
    harness.close();
  }
});

test("a lost create answer is retried with the same key and makes exactly one chat", async () => {
  const studio = new StudioHost();
  const { harness, control } = await start(studio);
  try {
    studio.drop.create = 1;
    await assert.rejects(control.start({ workspaceId: "ws-site" }, "Draft the notes"), code("create_unconfirmed"));
    assert.equal(studio.chats.size, 1, "the host created the chat before its answer was lost");
    assert.equal(studio.turns.length, 0, "nothing was sent into a chat this Mac never confirmed");

    const started = await control.start({ workspaceId: "ws-site" }, "Draft the notes");
    assert.equal(studio.chats.size, 1, "the retry replayed the same chat");
    assert.equal(started.chatId, [...studio.chats.keys()][0]);
    assert.deepEqual(studio.turns.map((turn) => turn.text), ["Draft the notes"]);
  } finally {
    harness.close();
  }
});

test("a project the host refuses leaves the draft unsent and the next attempt free to choose another", async () => {
  const studio = new StudioHost();
  const { harness, control } = await start(studio);
  try {
    await assert.rejects(
      control.start({ workspaceId: "ws-gone" }, "Hello"),
      (error: unknown) => error instanceof HostChatControlError && error.remoteCode === "not_found",
    );
    assert.equal(studio.chats.size, 0);
    const started = await control.start({ workspaceId: "ws-site" }, "Hello");
    assert.equal(studio.chats.get(started.chatId)?.workspaceId, "ws-site");
  } finally {
    harness.close();
  }
});

test("a first message whose answer was lost is retried with its key and never sent twice", async () => {
  const studio = new StudioHost();
  const { harness, control } = await start(studio);
  try {
    studio.drop.turn = 1;
    await assert.rejects(control.start({ workspaceId: "ws-site" }, "Ship it"), isOutcomeUnknown);
    const unresolved = control.getSnapshot().unresolved;
    assert.equal(unresolved?.text, "Ship it");
    assert.deepEqual(studio.turns.map((turn) => turn.text), ["Ship it"], "the host started the turn");

    await assert.rejects(control.start({ workspaceId: "ws-site" }, "Another"), code("unresolved"));
    assert.equal(await control.retryUnresolved(), unresolved?.chatId);
    assert.deepEqual(studio.turns.map((turn) => turn.text), ["Ship it"], "the retry replayed the original turn");
    assert.equal(studio.chats.size, 1);
    assert.equal(control.getSnapshot().unresolved, null);
  } finally {
    harness.close();
  }
});

test("a folder browsed on B becomes B's project, and a lost answer still makes one project", async () => {
  const studio = new StudioHost();
  const { harness, control } = await start(studio);
  try {
    const roots = await harness.adapter.roots();
    assert.ok(roots.ok);
    assert.deepEqual(roots.value.map((root) => root.label), ["Projects"]);
    const page = await harness.adapter.children(roots.value[0]!.location);
    assert.ok(page.ok);
    const launch = page.value.entries.find((entry) => entry.name === "launch");
    assert.ok(launch);

    const { selection } = await harness.adapter.selectFolder(launch.location);
    studio.drop.workspace = 1;
    const body = { mode: "selected-folder" as const, selection };
    await assert.rejects(control.createWorkspace(body), isOutcomeUnknown);
    const created = await control.createWorkspace(body);
    assert.equal(created.name, "launch");
    assert.equal(
      [...studio.workspaces.values()].filter((workspace) => workspace.name === "launch").length,
      1,
      "the retry reused its key instead of spending the selection twice",
    );

    const started = await control.start({ workspaceId: created.id }, "Set up the repo");
    assert.equal(studio.chats.get(started.chatId)?.workspaceId, created.id);
  } finally {
    harness.close();
  }
});

test("a Bot's chat opens on B, and opening it again returns the same chat", async () => {
  const studio = new StudioHost();
  const { harness, control } = await start(studio);
  try {
    const first = await control.openBotChat("bot-reviewer");
    const again = await control.openBotChat("bot-reviewer");
    assert.equal(again, first);
    assert.equal(studio.chats.get(first)?.botId, "bot-reviewer");
    assert.equal(studio.chats.size, 1);
  } finally {
    harness.close();
  }
});

test("a host that did not grant project management or Bot chats refuses them before anything is sent", async () => {
  const studio = new StudioHost();
  studio.host.capabilities = [...CAPABILITIES];
  const { harness, control } = await start(studio);
  try {
    const from = studio.host.calls.length;
    await assert.rejects(control.createWorkspace({ mode: "scratch" }), code("unsupported"));
    await assert.rejects(control.openBotChat("bot-reviewer"), code("unsupported"));
    assert.deepEqual(studio.requests(from), []);
  } finally {
    harness.close();
  }
});
