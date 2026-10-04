import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteHostFeedService, type AidenRemoteHostFeedState } from "./aiden-remote-host-feed.js";
import { AidenRemoteHostRunService } from "./aiden-remote-host-runs.js";
import {
  projectAidenRemoteChat,
  projectAidenRemoteChatMessagesWindow,
  type AidenRemoteChatSummaryProjection,
} from "./aiden-remote-chats.js";
import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import type { AidenRemoteRouterDependencies } from "./aiden-remote-router.js";
import { projectAidenRemoteWorkspace } from "./aiden-remote-workspaces.js";
import { HostRunRegistry } from "./host-run-registry.js";
import { PeerBootstrapTransport } from "./peer-bootstrap-transport.js";
import { PeerHostManager } from "./peer-host-manager.js";
import { PeerHostRegistry, type StoredPeerHost } from "./peer-host-registry.js";
import { startPeerTestHost, type PeerTestHost } from "./peer-pairing-test-host.js";
import { FakeTimers, hostControls, rendererIpc, type FakeHostEffects } from "./peer-remote-chat-test-host.js";
import { PeerTransport } from "./peer-transport.js";
import type { Workspace } from "./types.js";
import type { Chat, ChatMessage } from "../../renderer/lib/types.js";
import type { PeerHostStatus } from "../../renderer/shared/peer-host.js";
import { ChatSessionControl } from "../../renderer/lib/hosts/chat-session-control.js";
import { RemoteChatSession } from "../../renderer/lib/hosts/remote-chat-session.js";
import { RemoteHostAdapter } from "../../renderer/lib/hosts/remote-host-adapter.js";
import { RemoteNewChatControl } from "../../renderer/lib/hosts/remote-new-chat.js";
import { remoteSidebarRows, sidebarHosts } from "../../renderer/lib/sidebar-remote-groups.js";

/**
 * The whole multi-host path on real HTTPS, the way a user meets it: pair with
 * a setup code, find the other Mac's projects and chats in the sidebar, open
 * a chat, control its run, start new work, and come back after a dropped link
 * and a changed key. Every request crosses the real host router with the
 * credential and grants that pairing issued, and this Mac's registry,
 * supervisor, live IPC handlers, adapter and chat session are the production
 * ones. The per-feature suites (`peer-remote-chat-*.test.ts`,
 * `peer-remote-new-chat.test.ts`, `peer-host-*.test.ts`) cover the races and
 * failure modes; this pass proves the pieces meet.
 */

const APPROVAL = { approvalId: "ap-1", summary: "Run the release script", toolCallId: "call-1", toolName: "shell" };

/** Mac B: one project in a repository, two chats, a Bot, and a real run journal. */
class StudioMac {
  readonly runs = new HostRunRegistry({ now: Date.now, epoch: "runs_studio" });
  readonly effects: FakeHostEffects = { cancels: [], approvals: [], answers: [], inputs: [] };
  readonly turns: Array<{ chatId: string; text: string }> = [];
  readonly chats = new Map<string, Chat>();
  readonly feed: AidenRemoteHostFeedService;
  private readonly hostRuns: AidenRemoteHostRunService;
  private readonly workspace: Workspace = {
    id: "ws-site",
    name: "Site",
    folderPath: "/Users/b/site",
    permission: "ask",
    createdAt: 1_000,
    updatedAt: 2_000,
  };
  private readonly created = new Map<string, string>();
  private minted = 0;

  constructor() {
    for (const [id, title, updatedAt] of [
      ["chat-notes", "Release notes", 4_000],
      ["chat-bugs", "Bug triage", 3_000],
    ] as const) {
      this.chats.set(id, {
        id,
        title,
        workspaceId: this.workspace.id,
        createdAt: 1_000,
        updatedAt,
        messages: this.messages(id),
      });
    }
    this.hostRuns = new AidenRemoteHostRunService({
      registry: this.runs,
      controls: hostControls(this.runs, this.effects),
      now: Date.now,
      heartbeatMs: 3_600_000,
    });
    this.feed = new AidenRemoteHostFeedService({
      source: { read: async () => this.state() },
      now: Date.now,
      debounceMs: 5,
      heartbeatMs: 3_600_000,
    });
    this.runs.onChange((summary, removed) => this.feed.noteRun(summary, removed));
  }

  /** What B's router serves besides pairing. */
  services(): Partial<Pick<AidenRemoteRouterDependencies, "chats" | "bots" | "hostFeed" | "hostRuns">> {
    const chats = {
      list: async () => [],
      classify: async (chatId: string) => {
        const chat = this.chat(chatId);
        return chat.botId ? { botId: chat.botId } : {};
      },
      authorizeRetainedBotChat: async () => true,
      runMutation: async <T>(_device: string, _chat: string, _classification: unknown, action: () => Promise<T>) =>
        action(),
      get: async (chatId: string) => projectAidenRemoteChat(this.chat(chatId)),
      messagesWindow: async (chatId: string, input: { before?: string; limit: number }) =>
        projectAidenRemoteChatMessagesWindow(this.chat(chatId), input),
      create: async (_device: string, _key: string, body: { workspaceId?: string; title?: string }) =>
        projectAidenRemoteChat(this.add({ workspaceId: body.workspaceId ?? this.workspace.id })),
      startTurn: async (_device: string, chatId: string, _key: string, body: { text: string }) => {
        const chat = this.chat(chatId);
        const turn = this.turns.push({ chatId, text: body.text });
        const message: ChatMessage = { id: `sent-${turn}`, role: "user", content: body.text, createdAt: 9_000 + turn };
        this.chats.set(chatId, { ...chat, messages: [...chat.messages, message], updatedAt: chat.updatedAt + 1 });
        this.runs.begin({ runId: `run-turn-${turn}`, chatId, origin: "remote" });
        return {
          turnId: `turn_${turn}`,
          streamId: `run-turn-${turn}`,
          status: "accepted" as const,
          message: projectAidenRemoteChat({ ...chat, messages: [message] }).messages[0]!,
        };
      },
    };
    const bots = {
      createChat: async (_device: string, botId: string) => {
        const existing = this.created.get(botId);
        const chat = existing ? this.chat(existing) : this.add({ workspaceId: this.workspace.id, botId });
        this.created.set(botId, chat.id);
        return projectAidenRemoteChat(chat);
      },
    };
    return {
      chats: chats as unknown as AidenRemoteRouterDependencies["chats"],
      bots: bots as unknown as AidenRemoteRouterDependencies["bots"],
      hostFeed: this.feed,
      hostRuns: this.hostRuns,
    };
  }

  /** Persists an assistant reply, as the host does before announcing `done`. */
  reply(chatId: string, content: string): void {
    const chat = this.chat(chatId);
    const message: ChatMessage = { id: `reply-${chat.messages.length}`, role: "assistant", content, createdAt: 9_500 };
    this.chats.set(chatId, { ...chat, messages: [...chat.messages, message], updatedAt: chat.updatedAt + 1 });
    this.feed.invalidate();
  }

  close(): void {
    this.feed.close();
  }

  private messages(chatId: string): ChatMessage[] {
    return [
      { id: `${chatId}-q`, role: "user", content: `What is left for ${chatId}?`, createdAt: 1_100 },
      { id: `${chatId}-a`, role: "assistant", content: `Two items for ${chatId}.`, createdAt: 1_200 },
    ];
  }

  private add(input: { workspaceId: string; botId?: string }): Chat {
    const id = `chat-new-${++this.minted}`;
    const chat: Chat = {
      id,
      title: "New chat",
      workspaceId: input.workspaceId,
      createdAt: 5_000 + this.minted,
      updatedAt: 5_000 + this.minted,
      messages: [],
      ...(input.botId ? { botId: input.botId } : {}),
    };
    this.chats.set(id, chat);
    this.feed.invalidate();
    return chat;
  }

  private chat(chatId: string): Chat {
    const chat = this.chats.get(chatId);
    if (!chat) throw new AidenRemoteServiceError("not_found", "That chat is not available.", 404);
    return chat;
  }

  private state(): AidenRemoteHostFeedState {
    const summaries: AidenRemoteChatSummaryProjection[] = [...this.chats.values()]
      .filter((chat) => !chat.botId)
      .map((chat) => ({
        id: chat.id,
        workspaceId: chat.workspaceId ?? this.workspace.id,
        title: chat.title,
        titlePending: false,
        createdAt: new Date(chat.createdAt).toISOString(),
        updatedAt: new Date(chat.updatedAt).toISOString(),
        revision: `rev_${chat.id}_${chat.updatedAt}`,
        activity: "idle",
      }));
    return {
      summaries,
      botChatIds: new Set([...this.chats.values()].filter((chat) => chat.botId).map((chat) => chat.id)),
      workspaces: [
        {
          ...projectAidenRemoteWorkspace(this.workspace),
          repository: { canonicalKey: "github.com/b/site", relativePath: "" },
        },
      ],
      bots: [{ id: "bot-reviewer", name: "Reviewer" }],
    };
  }
}

/** This Mac's paired-device registry, trusting the fixture CA in place of the system roots. */
function registryFor(host: PeerTestHost): PeerHostRegistry {
  let saved: StoredPeerHost[] = [];
  return new PeerHostRegistry({
    storage: {
      load: async () => structuredClone(saved),
      save: async (next) => {
        saved = structuredClone(next);
      },
    },
    localInstanceId: async () => "install_travel",
    deviceName: "Travel MacBook",
    clientVersion: "0.60.0",
    platform: "mac",
    client: (trust) =>
      new PeerTransport({
        endpoint: trust.endpoint,
        serverSpkiSha256: trust.serverSpkiSha256,
        caCertificateDerBase64: trust.caCertificateDerBase64 ?? host.caDerBase64,
      }),
    bootstrap: (session) => new PeerBootstrapTransport({ ...session, ca: host.caPem }),
  });
}

/** Wait on real network I/O, letting the supervisor's backoff timers run as time passes. */
async function until(check: () => boolean, timers?: FakeTimers, label = "the expected state"): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
    timers?.advance(1_000);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a Mac paired by setup code finds, follows and controls another Mac's work, and comes back after a dropped link and a new key", async (t) => {
  const studio = new StudioMac();
  const host = await startPeerTestHost({ services: studio.services() });
  const registry = registryFor(host);
  const timers = new FakeTimers();
  const ipc = rendererIpc();
  let manager: PeerHostManager | undefined;
  t.after(async () => {
    manager?.close();
    studio.close();
    await host.close();
  });

  // Pair: the setup code shown on B, typed on this Mac.
  const paired = await registry.pairWithSetupCode({ endpoint: host.lanEndpoint, code: host.openSetupCode("lan") });
  assert.equal(paired.id, host.instanceId);

  manager = new PeerHostManager({ registry, broadcast: ipc.broadcast, now: () => timers.now, random: () => 0.5, timers });
  const { transport } = ipc.attach(manager);
  const supervisor = manager;
  const status = (): PeerHostStatus["state"] | undefined =>
    supervisor.statuses().find((entry) => entry.hostId === paired.id)?.state;
  const sidebar = async () => {
    const views = await registry.list();
    const [entry] = sidebarHosts(views, supervisor.statuses());
    assert.ok(entry);
    return { host: entry, ...remoteSidebarRows(entry, supervisor.feedSnapshot(paired.id) ?? undefined) };
  };
  await until(() => (supervisor.feedSnapshot(paired.id)?.summaries.length ?? 0) === 2, undefined, "B's feed");

  // The sidebar shows B's project with its repository and both chats inside it, from the feed alone.
  const first = await sidebar();
  assert.equal(first.host.availability, "online");
  assert.deepEqual(
    first.projects.map((project) => [project.name, project.repository?.canonicalKey, project.stale]),
    [["Site", "github.com/b/site", false]],
  );
  assert.deepEqual(
    first.chats.map((chat) => [chat.title, chat.projectKey === first.projects[0]!.key, chat.rowState]).sort(),
    [["Bug triage", true, "idle"], ["Release notes", true, "idle"]],
  );
  assert.equal(host.seen.filter((line) => line.includes("/messages")).length, 0, "the sidebar reads no transcript");

  // Open a chat and read its transcript.
  const [view] = await registry.list();
  const adapter = new RemoteHostAdapter(view!, transport);
  await adapter.ready();
  const session = new RemoteChatSession({ adapter, chatId: "chat-notes" });
  t.after(() => {
    session.dispose();
    adapter.dispose();
  });
  session.start();
  await until(() => session.getSnapshot().transcript.messages.length === 2, undefined, "the transcript");
  assert.deepEqual(
    session.getSnapshot().transcript.messages.map((message) => message.content),
    ["What is left for chat-notes?", "Two items for chat-notes."],
  );
  const control = new ChatSessionControl(adapter, { hostId: paired.id, chatId: "chat-notes" });
  t.after(control.attach());

  // A run that B started asks for approval; this Mac sees it, the sidebar flags it, and approving reaches B.
  studio.runs.begin({ runId: "run-1", chatId: "chat-notes", origin: "renderer" });
  studio.runs.publish("run-1", "chat:delta", { delta: "Drafting the notes" });
  studio.runs.publish("run-1", "chat:approval", APPROVAL);
  await until(() => session.getSnapshot().run.approvals.length === 1, undefined, "the approval");
  await until(
    () => supervisor.feedSnapshot(paired.id)?.runs.some((run) => run.runId === "run-1" && run.state === "needs_approval") === true,
    undefined,
    "the run state in the feed",
  );
  const waiting = await sidebar();
  assert.equal(waiting.chats.find((chat) => chat.chatId === "chat-notes")?.rowState, "needs_approval");
  const approved = await control.respondApproval({ runId: "run-1", approvalId: "ap-1", decision: "allow" });
  assert.equal(approved?.resolution, "applied");
  await until(() => session.getSnapshot().run.approvals.length === 0, undefined, "the approval to clear");

  // A second approval is denied, then the run is stopped.
  studio.runs.publish("run-1", "chat:approval", { ...APPROVAL, approvalId: "ap-2", toolCallId: "call-2" });
  await until(() => session.getSnapshot().run.approvals.length === 1, undefined, "the second approval");
  await control.respondApproval({ runId: "run-1", approvalId: "ap-2", decision: "deny" });
  assert.equal(await control.cancel("run-1"), true);
  assert.deepEqual(studio.effects.approvals, ["ap-1:allow", "ap-2:deny"]);
  assert.deepEqual(studio.effects.cancels, ["run-1"]);
  await until(() => session.getSnapshot().run.status === "cancelled", undefined, "the stopped run");

  // Continue the chat: the turn runs on B and its reply appears here.
  await control.send("Ship the release");
  assert.deepEqual(studio.turns, [{ chatId: "chat-notes", text: "Ship the release" }]);
  await until(() => session.getSnapshot().run.runId === "run-turn-1", undefined, "the new turn's run");
  studio.reply("chat-notes", "Released.");
  studio.runs.publish("run-turn-1", "chat:done", {});
  await until(
    () => session.getSnapshot().transcript.messages.slice(-1)[0]?.content === "Released.",
    undefined,
    "the reply",
  );

  // Start new work on B: a chat in B's project, and a Bot's chat.
  const starter = new RemoteNewChatControl(adapter);
  t.after(starter.attach());
  const started = await starter.start({ workspaceId: "ws-site" }, "Plan the launch");
  assert.equal(studio.chats.get(started.chatId)?.workspaceId, "ws-site");
  assert.deepEqual(studio.turns.slice(-1)[0], { chatId: started.chatId, text: "Plan the launch" });
  await until(
    () => supervisor.feedSnapshot(paired.id)?.summaries.some((row) => row.id === started.chatId) === true,
    undefined,
    "the new chat in the feed",
  );
  assert.ok((await sidebar()).chats.some((chat) => chat.chatId === started.chatId), "the new chat is in the sidebar");
  const botChat = await starter.openBotChat("bot-reviewer");
  assert.equal(studio.chats.get(botChat)?.botId, "bot-reviewer");
  assert.equal(await starter.openBotChat("bot-reviewer"), botChat, "the Bot's chat is reused");

  // The link drops: this Mac shows B offline, then resumes the feed from its cursor.
  const sequenceBefore = supervisor.feedSnapshot(paired.id)!.sequence;
  const receivedBefore = host.received.length;
  host.dropConnections();
  await until(() => status()?.kind !== "connected", undefined, "the dropped link");
  assert.equal((await sidebar()).host.availability === "online", false);
  await until(() => status()?.kind === "connected", timers, "the reconnect");
  const resume = host.received
    .slice(receivedBefore)
    .find((entry) => entry.line.startsWith("GET /api/aiden/v1/host/events"));
  assert.equal(
    resume?.headers["last-event-id"],
    `${supervisor.feedSnapshot(paired.id)!.epoch}:${sequenceBefore}`,
    "the feed resumes from where it was",
  );
  // B has nothing new to send, and its heartbeat is an hour away: the resumed feed is live at once.
  await until(() => status()?.kind === "connected" && supervisor.feedSnapshot(paired.id)?.stale === false, undefined, "the live feed");
  assert.ok((await sidebar()).chats.every((chat) => !chat.stale), "B's rows are current again");

  // B renews its key: the pin no longer matches and this Mac blocks rather than trusting it.
  await host.rotateLeaf();
  await until(
    () => status()?.kind === "blocked",
    timers,
    "the identity block",
  );
  assert.deepEqual(status(), { kind: "blocked", reason: "identity_changed" });
  const blocked = await sidebar();
  assert.equal(blocked.host.availability, "blocked");
  assert.ok(blocked.chats.every((chat) => chat.stale), "B's rows stay visible but stale");
  await supervisor.reconnect(paired.id);
  assert.deepEqual(status(), { kind: "blocked", reason: "identity_changed" }, "a plain reconnect cannot clear it");

  // Pairing again with a fresh setup code replaces the trust and supervision resumes.
  await registry.pairWithSetupCode(
    { endpoint: host.lanEndpoint, code: host.openSetupCode("lan") },
    undefined,
    { replaceHostId: paired.id },
  );
  await supervisor.reconnect(paired.id, { repaired: true });
  await until(() => status()?.kind === "connected", timers, "the repaired connection");
  await until(() => supervisor.feedSnapshot(paired.id)?.stale === false, undefined, "the fresh feed");
  const repaired = await sidebar();
  assert.equal(repaired.host.availability, "online");
  assert.ok(repaired.chats.some((chat) => chat.chatId === "chat-notes" && !chat.stale));
});
