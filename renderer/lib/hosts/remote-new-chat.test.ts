import assert from "node:assert/strict";
import test from "node:test";
import {
  HostChatControlError,
  type HostChatAttachmentUpload,
  type HostChatCapability,
  type HostChatSendInput,
  type HostChatStatus,
  type HostChatTurnReceipt,
} from "./host-chat-adapter";
import type { HostCreatedChat, HostCreatedWorkspace, HostNewChatInput, HostWorkspaceCreate } from "./host-resources";
import { ChatIntentLedger } from "./chat-intent-ledger";
import { RemoteNewChatControl, RemoteNewChatMemory, type RemoteNewChatHost } from "./remote-new-chat";

const lost = () => new HostChatControlError({ code: "outcome_unknown", message: "lost" });

/**
 * A paired host with an idempotency ledger: a repeated key returns what the
 * first request made. Any step can lose its acknowledgement after the host
 * already acted, the way a dropped connection does.
 */
class FakeHost implements RemoteNewChatHost {
  readonly hostId = "host-b";
  current: HostChatStatus = { availability: "online", generation: 1 };
  granted = new Set<HostChatCapability>(["send", "attach", "createChat", "createWorkspace", "browseFolders", "botChats"]);
  readonly chats = new Map<string, HostCreatedChat & { model?: HostNewChatInput["model"] }>();
  readonly workspaces = new Map<string, HostCreatedWorkspace>();
  readonly turns = new Map<string, { chatId: string; text: string; attachmentIds?: string[] }>();
  readonly staged = new Set<string>();
  readonly ledger = new Map<string, string>();
  readonly calls: string[] = [];
  lose = new Set<"create" | "send" | "workspace" | "bot">();
  refuse = new Set<"create" | "send">();
  /** The next send is lost on the way: the host never sees it. */
  vanish = false;
  /** Unused uploads the host keeps per chat before refusing more, like the real host's limit. */
  uploadLimit = Infinity;
  /** Single-use folder selections, by token. */
  readonly selections = new Map<string, string>();
  private uploads = 0;

  capabilities() {
    return this.granted;
  }
  status() {
    return this.current;
  }
  onStatus() {
    return () => {};
  }
  private drop(step: "create" | "send" | "workspace" | "bot") {
    if (this.lose.delete(step)) throw lost();
  }
  async createChat(input: HostNewChatInput, key: string): Promise<HostCreatedChat> {
    this.calls.push(`createChat:${input.workspaceId}`);
    // The ledger replays a refusal for its key as faithfully as a success.
    if (this.refuse.delete("create")) this.ledger.set(key, "refused");
    if (this.ledger.get(key) === "refused") throw new HostChatControlError({ code: "not_found", message: "No such project." });
    let id = this.ledger.get(key);
    if (!id) {
      id = `chat-${this.chats.size + 1}`;
      this.ledger.set(key, id);
      this.chats.set(id, { id, workspaceId: input.workspaceId, ...(input.model ? { model: input.model } : {}) });
    }
    this.drop("create");
    const { model: _model, ...chat } = this.chats.get(id)!;
    return chat;
  }
  async createWorkspace(body: HostWorkspaceCreate, key: string): Promise<HostCreatedWorkspace> {
    this.calls.push(`createWorkspace:${body.mode}`);
    let id = this.ledger.get(key);
    if (!id) {
      let name = body.mode === "folderless" ? body.name : "Scratch";
      if (body.mode === "selected-folder") {
        // A selection is spent once, and a folder is registered as one project.
        const location = this.selections.get(body.selection);
        if (!location) throw new HostChatControlError({ code: "invalid_request", message: "That folder selection expired." });
        this.selections.delete(body.selection);
        if ([...this.workspaces.values()].some((workspace) => workspace.name === location)) {
          throw new HostChatControlError({ code: "already_exists", message: "That folder is already a project." });
        }
        name = location;
      }
      id = `ws-${this.workspaces.size + 1}`;
      this.ledger.set(key, id);
      this.workspaces.set(id, { id, name });
    }
    this.drop("workspace");
    return this.workspaces.get(id)!;
  }
  async createBotChat(botId: string, key: string): Promise<HostCreatedChat> {
    this.calls.push(`createBotChat:${botId}`);
    // A Bot has one canonical chat; asking again returns it.
    const existing = [...this.chats.values()].find((chat) => chat.botId === botId);
    const chat = existing ?? { id: `chat-${this.chats.size + 1}`, workspaceId: "ws-bots", botId };
    this.chats.set(chat.id, chat);
    this.ledger.set(key, chat.id);
    this.drop("bot");
    return chat;
  }
  async selectFolder(location: string) {
    this.calls.push(`select:${location}`);
    const selection = `sel-${this.selections.size + this.calls.length}`;
    this.selections.set(selection, location);
    return { selection, displayName: location };
  }
  async uploadAttachment(chatId: string, upload: HostChatAttachmentUpload) {
    if (this.staged.size >= this.uploadLimit) throw new HostChatControlError({ code: "rate_limited", message: "Too many unused attachments." });
    this.uploads += 1;
    const id = `att-${this.uploads}`;
    this.calls.push(`upload:${chatId}:${upload.name}`);
    this.staged.add(id);
    return { id, name: upload.name, size: 1 };
  }
  async removeAttachment(chatId: string, attachmentId: string) {
    this.calls.push(`release:${chatId}:${attachmentId}`);
    this.staged.delete(attachmentId);
  }
  async send(chatId: string, input: HostChatSendInput): Promise<HostChatTurnReceipt> {
    this.calls.push(`send:${chatId}`);
    if (this.vanish) {
      this.vanish = false;
      throw lost();
    }
    if (this.refuse.delete("send")) throw new HostChatControlError({ code: "busy", message: "Busy." });
    if (!this.turns.has(input.idempotencyKey)) {
      this.turns.set(input.idempotencyKey, {
        chatId,
        text: input.text,
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
      });
      for (const id of input.attachmentIds ?? []) this.staged.delete(id);
    }
    this.drop("send");
    const turnId = `turn-${[...this.turns.keys()].indexOf(input.idempotencyKey) + 1}`;
    return { turnId, streamId: `run-${turnId}` };
  }
}

function control(host = new FakeHost(), memory = { ledger: new ChatIntentLedger(), memory: new RemoteNewChatMemory() }) {
  const value = new RemoteNewChatControl(host, memory);
  value.attach();
  return { host, control: value, memory };
}

const target: HostNewChatInput = { workspaceId: "ws-b", model: { providerId: "acme", modelId: "fast" } };
const notes: HostChatAttachmentUpload = { name: "notes.md", mimeType: "text/markdown", kind: "text", text: "# Notes" };

test("a new chat is created in the host's project with the chosen model, then its first turn starts there", async () => {
  const { host, control: c } = control();
  const started = await c.start(target, "Plan the release", [notes]);

  assert.equal(started.chatId, "chat-1");
  assert.deepEqual(host.chats.get("chat-1"), { id: "chat-1", workspaceId: "ws-b", model: target.model });
  assert.deepEqual([...host.turns.values()], [{ chatId: "chat-1", text: "Plan the release", attachmentIds: ["att-1"] }]);
  assert.deepEqual(host.calls, ["createChat:ws-b", "upload:chat-1:notes.md", "send:chat-1"]);
  assert.equal(c.getSnapshot().starting, false);
});

test("a lost create answer is resent with the same key, so the host makes one chat", async () => {
  const { host, control: c } = control();
  host.lose.add("create");
  await assert.rejects(c.start(target, "Hello"), { code: "create_unconfirmed", retryable: true });
  assert.equal(host.turns.size, 0, "no turn starts until the chat is confirmed");

  const started = await c.start(target, "Hello");
  assert.equal(host.chats.size, 1);
  assert.equal(started.chatId, "chat-1");
  assert.equal(host.turns.size, 1);
});

test("changing the project or model after a lost create asks the host for a different chat", async () => {
  const { host, control: c } = control();
  host.lose.add("create");
  await assert.rejects(c.start(target, "Hello"), { code: "create_unconfirmed" });
  await c.start({ workspaceId: "ws-c" }, "Hello");
  assert.deepEqual([...host.chats.values()].map((chat) => chat.workspaceId), ["ws-b", "ws-c"]);
});

test("a definite create refusal starts over with a new key on the next attempt", async () => {
  const { host, control: c } = control();
  host.refuse.add("create");
  await assert.rejects(c.start(target, "Hello"), { code: "not_found" });
  const started = await c.start(target, "Hello");
  assert.equal(started.chatId, "chat-1", "a reused key would have replayed the refusal");
});

test("a lost first turn is held as unresolved and retried with the same key", async () => {
  const { host, control: c } = control();
  host.lose.add("send");
  await assert.rejects(c.start(target, "Hello", [notes]), { code: "outcome_unknown" });

  const unresolved = c.getSnapshot().unresolved;
  assert.equal(unresolved?.chatId, "chat-1");
  assert.equal(unresolved?.text, "Hello");
  await assert.rejects(c.start(target, "Another"), { code: "unresolved" });

  assert.equal(await c.retryUnresolved(), "chat-1");
  assert.equal(host.turns.size, 1, "the retry replayed the turn the host already started");
  assert.equal(host.chats.size, 1);
  assert.equal(c.getSnapshot().unresolved, null);
  assert.equal(host.calls.filter((call) => call.startsWith("upload")).length, 1, "the retry does not upload again");
});

test("a refused first turn keeps the empty chat for the next attempt and releases its uploads", async () => {
  const { host, control: c } = control();
  host.refuse.add("send");
  await assert.rejects(c.start(target, "Hello", [notes]), { code: "busy" });
  await Promise.resolve();
  assert.equal(host.staged.size, 0);

  await c.start(target, "Hello again");
  assert.equal(host.chats.size, 1, "the empty chat is reused");
  assert.deepEqual(
    host.calls.filter((call) => call.startsWith("createChat")),
    ["createChat:ws-b"],
  );
  assert.deepEqual([...host.turns.values()].map((turn) => turn.text), ["Hello again"]);
});

test("dismissing an unresolved first turn sends nothing", async () => {
  const { host, control: c } = control();
  host.lose.add("send");
  await assert.rejects(c.start(target, "Hello"), { code: "outcome_unknown" });
  const before = host.calls.length;
  assert.equal(c.dismissUnresolved()?.chatId, "chat-1");
  assert.equal(c.getSnapshot().unresolved, null);
  assert.equal(host.calls.length, before);
});

test("an offline host or a missing grant refuses before anything reaches the host", async () => {
  const { host, control: c } = control();
  host.current = { availability: "offline", generation: 1 };
  await assert.rejects(c.start(target, "Hello"), { code: "host_unavailable" });

  host.current = { availability: "online", generation: 1 };
  host.granted = new Set<HostChatCapability>(["send", "createChat"]);
  await assert.rejects(c.start(target, "Hello", [notes]), { code: "unsupported" });
  await assert.rejects(c.createWorkspace({ mode: "scratch" }), { code: "unsupported" });
  await assert.rejects(c.openBotChat("bot-1"), { code: "unsupported" });
  assert.deepEqual(host.calls, []);
});

test("a project whose create answer was lost is created once when asked again", async () => {
  const { host, control: c } = control();
  host.lose.add("workspace");
  const request: HostWorkspaceCreate = { mode: "folderless", name: "Launch" };
  await assert.rejects(c.createWorkspace(request), { code: "outcome_unknown" });
  const workspace = await c.createWorkspace(request);
  assert.equal(host.workspaces.size, 1);
  assert.equal(workspace.name, "Launch");

  // A different request after a definite answer is a different project.
  await c.createWorkspace({ mode: "folderless", name: "Launch" });
  assert.equal(host.workspaces.size, 2);
});

test("opening a Bot's chat returns the host's canonical chat for that Bot", async () => {
  const { host, control: c } = control();
  const first = await c.openBotChat("bot-1");
  const again = await c.openBotChat("bot-1");
  assert.equal(first, again);
  assert.equal([...host.chats.values()].filter((chat) => chat.botId === "bot-1").length, 1);
});

test("a lost first turn and a lost create both survive the control being rebuilt", async () => {
  const { host, control: first, memory } = control();
  host.lose.add("create");
  await assert.rejects(first.start(target, "Hello"), { code: "create_unconfirmed" });

  // Leaving the page, or a grants change, builds a new control for the same host.
  const second = new RemoteNewChatControl(host, memory);
  second.attach();
  host.lose.add("send");
  await assert.rejects(second.start(target, "Hello", [notes]), { code: "outcome_unknown" });
  assert.equal(host.chats.size, 1, "the rebuilt control reused the lost create's key");

  const third = new RemoteNewChatControl(host, memory);
  third.attach();
  assert.equal(third.getSnapshot().unresolved?.text, "Hello", "the unresolved first turn is still offered");
  assert.equal(await third.retryUnresolved(), "chat-1");
  assert.equal(host.turns.size, 1, "the retry replayed the original turn");
  assert.equal(second.getSnapshot().unresolved, null, "every control sees it resolved");
});

test("choosing the same folder again after a lost answer makes one project", async () => {
  const { host, control: c } = control();
  host.lose.add("workspace");
  await assert.rejects(c.createFolderWorkspace("launch"), { code: "outcome_unknown" });
  const created = await c.createFolderWorkspace("launch");
  assert.equal(created.name, "launch");
  assert.equal(host.workspaces.size, 1);
  assert.equal(host.calls.filter((call) => call.startsWith("select:")).length, 1, "the retry replayed the original selection");

  // A definite answer ends the intent: the next choice is a new request with a new selection.
  await assert.rejects(c.createFolderWorkspace("launch"), { code: "already_exists" });
  await assert.rejects(c.createFolderWorkspace("launch"), { code: "already_exists" });
  assert.equal(host.calls.filter((call) => call.startsWith("select:")).length, 3, "a refused request is not replayed");
});

test("dismissing a first turn that never arrived frees its uploads for the next chat", async () => {
  const { host, control: c } = control();
  host.uploadLimit = 1;
  host.vanish = true;
  await assert.rejects(c.start(target, "Hello", [notes]), { code: "outcome_unknown" });
  assert.equal(host.staged.size, 1);

  c.dismissUnresolved();
  await c.start({ workspaceId: "ws-c" }, "Hello again", [notes]);
  assert.deepEqual([...host.turns.values()].map((turn) => turn.text), ["Hello again"]);
});

test("a first turn the host refuses on retry frees its uploads, and the next send reuses the empty chat", async () => {
  const { host, control: c } = control();
  host.uploadLimit = 1;
  host.vanish = true;
  await assert.rejects(c.start(target, "Hello", [notes]), { code: "outcome_unknown" });

  host.refuse.add("send");
  await assert.rejects(c.retryUnresolved(), { code: "busy" });
  assert.equal(c.getSnapshot().unresolved, null);
  const started = await c.start(target, "Hello again", [notes]);
  assert.equal(started.chatId, "chat-1");
  assert.deepEqual([...host.turns.values()].map((turn) => turn.text), ["Hello again"]);
});
