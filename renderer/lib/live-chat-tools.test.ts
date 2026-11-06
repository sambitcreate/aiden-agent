import assert from "node:assert/strict";
import test from "node:test";
import { LiveChatControlRegistry, type LiveChatController } from "./live-chat-control";
import {
  LIVE_CHAT_ACCESS_NOTICE,
  createLiveChatAccessNotice,
  createLiveChatToolHandlers,
  type LiveChatToolDeps,
} from "./live-chat-tools";
import { LiveSessionBus } from "./live-session-bus";

function controller(overrides: Partial<LiveChatController> = {}): LiveChatController & { sent: string[] } {
  const sent: string[] = [];
  return {
    chatId: "chat-1",
    workspaceId: "ws-1",
    isDraft: false,
    read: () => ({ title: "Fix login", busy: false, waitingForApproval: false, messages: [], truncated: false }),
    send: async (text, mode) => {
      sent.push(`${mode}:${text}`);
      return { ok: true, status: "sent", title: "Fix login" };
    },
    stop: () => ({ ok: true, status: "stopping" }),
    sent,
    ...overrides,
  };
}

function harness(overrides: Partial<LiveChatToolDeps> = {}) {
  const registry = new LiveChatControlRegistry();
  const log: string[] = [];
  let enabled = true;
  const deps: LiveChatToolDeps = {
    enabled: () => enabled,
    controller: () => registry.current(),
    waitForController: (predicate, signal) => registry.waitFor(predicate, signal, 200),
    listChats: async () => [
      { id: "chat-1", title: "Fix login", updatedAt: 3 },
      { id: "chat-2", title: "Release notes", updatedAt: 2 },
      { id: "chat-3", title: "Plan the launch", updatedAt: 5 },
      { id: "chat-4", title: "Plan the offsite", updatedAt: 4 },
    ],
    openChat: async (chatId) => {
      log.push(`open:${chatId}`);
      return true;
    },
    listWorkspaces: async () => [
      { id: "ws-1", name: "Website" },
      { id: "ws-2", name: "Mobile app" },
    ],
    currentWorkspaceId: () => "ws-1",
    openNewChatIn: async (workspaceId) => {
      log.push(`new:${workspaceId}`);
      return true;
    },
    used: () => log.push("used"),
    watch: (chatId, title) => log.push(`watch:${chatId}:${title}`),
    ...overrides,
  };
  const handlers = createLiveChatToolHandlers(deps);
  const signal = new AbortController().signal;
  const run = (name: keyof typeof handlers, args: Record<string, unknown> = {}, abort = signal) =>
    Promise.resolve(handlers[name](args, { sessionId: "s1", signal: abort }));
  return { registry, log, run, handlers, setEnabled: (value: boolean) => (enabled = value) };
}

const code = (result: Record<string, unknown>) => (result.error as { code: string } | undefined)?.code;

test("with chat access off every tool refuses and nothing is touched", async () => {
  const { registry, log, run, setEnabled } = harness();
  const open = controller();
  registry.register(Symbol(), open);
  setEnabled(false);
  for (const name of ["read_open_chat", "send_to_open_chat", "stop_open_chat", "find_and_open_chat", "start_new_chat"] as const) {
    assert.equal(code(await run(name, { text: "Hi", mode: "auto", query: "fix" })), "chat_access_off", name);
  }
  assert.deepEqual(log, []);
  assert.deepEqual(open.sent, []);
});

test("without an open chat, read, send and stop say so", async () => {
  const { run, log } = harness();
  for (const name of ["read_open_chat", "send_to_open_chat", "stop_open_chat"] as const) {
    assert.equal(code(await run(name, { text: "Hi", mode: "auto" })), "no_open_chat", name);
  }
  assert.deepEqual(log, ["used", "used", "used"], "each use reaches the one-time notice check");
});

test("a send goes through the open chat's controller and its chat is watched for notes", async () => {
  const { registry, run, log } = harness();
  const open = controller();
  registry.register(Symbol(), open);
  assert.deepEqual(await run("send_to_open_chat", { text: " Run the tests ", mode: "steer" }), {
    ok: true,
    status: "sent",
    title: "Fix login",
  });
  assert.deepEqual(open.sent, ["steer:Run the tests"]);
  assert.deepEqual(log, ["used", "watch:chat-1:Fix login"]);
  // Bounds are checked again in the window.
  assert.equal(code(await run("send_to_open_chat", { text: "x".repeat(4_001), mode: "auto" })), "invalid_arguments");
  assert.equal(code(await run("send_to_open_chat", { text: "Hi", mode: "allow" })), "invalid_arguments");
  assert.deepEqual(open.sent, ["steer:Run the tests"]);
});

test("a refused send is not watched", async () => {
  const { registry, run, log } = harness();
  registry.register(Symbol(), controller({ send: async () => ({ ok: false, error: { code: "cannot_steer", message: "No." } }) }));
  assert.equal(code(await run("send_to_open_chat", { text: "Hi", mode: "steer" })), "cannot_steer");
  assert.deepEqual(log, ["used"]);
});

test("find opens one clear match, offers close titles instead of guessing, and respects blocked navigation", async () => {
  const { run, log } = harness();
  assert.deepEqual(await run("find_and_open_chat", { query: "release notes" }), {
    ok: true,
    opened: true,
    title: "Release notes",
  });
  assert.deepEqual(await run("find_and_open_chat", { query: "plan" }), {
    ok: true,
    opened: false,
    closeMatches: ["Plan the launch", "Plan the offsite"],
  });
  assert.equal(code(await run("find_and_open_chat", { query: "tax return" })), "chat_not_found");
  assert.deepEqual(log.filter((entry) => entry.startsWith("open:")), ["open:chat-2"]);

  const blocked = harness({ openChat: async () => false });
  assert.equal(code(await blocked.run("find_and_open_chat", { query: "release notes" })), "navigation_blocked");
});

test("start opens a draft in the named workspace and sends the first message there", async () => {
  const { registry, run, log } = harness({
    openNewChatIn: async (workspaceId) => {
      log.push(`new:${workspaceId}`);
      // The draft's pane registers a moment later, as ChatPane does after navigation.
      setTimeout(() => registry.register(Symbol(), draft), 5);
      return true;
    },
  });
  const draft = controller({ chatId: "draft-1", workspaceId: "ws-2", isDraft: true });
  registry.register(Symbol(), controller());
  assert.deepEqual(await run("start_new_chat", { workspace: "mobile", text: "Plan the release" }), {
    ok: true,
    status: "sent",
    title: "Fix login",
    started: true,
    workspace: "Mobile app",
  });
  assert.deepEqual(draft.sent, ["auto:Plan the release"]);
  assert.deepEqual(log, ["used", "new:ws-2", "watch:draft-1:Fix login"]);
});

test("start without a name uses the current workspace and sends nothing without text", async () => {
  const { registry, run, log } = harness({
    openNewChatIn: async (workspaceId) => {
      log.push(`new:${workspaceId}`);
      registry.register(Symbol(), controller({ chatId: "draft-2", isDraft: true }));
      return true;
    },
  });
  assert.deepEqual(await run("start_new_chat"), { ok: true, started: true, workspace: "Website" });
  assert.deepEqual(log, ["used", "new:ws-1"]);
  assert.equal(code(await run("start_new_chat", { workspace: "backend" })), "workspace_not_found");
});

test("start gives up when the new chat never opens or the call is cancelled", async () => {
  const { run } = harness({ openNewChatIn: async () => true });
  assert.equal(code(await run("start_new_chat")), "new_chat_failed");
  const abort = new AbortController();
  const pending = run("start_new_chat", {}, abort.signal);
  abort.abort();
  assert.equal(code(await pending), "cancelled");
});

test("handlers registered on the session bus answer main's requests", async () => {
  const bus = new LiveSessionBus();
  const results: Array<Record<string, unknown>> = [];
  bus.setSession("s1", {
    toolResult: async (_session, _request, response) => {
      results.push(response);
      return true;
    },
    note: async () => true,
  });
  const { handlers, registry } = harness();
  registry.register(Symbol(), controller());
  bus.registerTool("stop_open_chat", handlers.stop_open_chat);
  await bus.runToolRequest({ sessionId: "s1", requestId: "r1", name: "stop_open_chat", args: {} });
  assert.deepEqual(results, [{ ok: true, status: "stopping" }]);
});

test("the chat access notice shows once and is remembered, and never once a saved setting says it was shown", async () => {
  const shown: string[] = [];
  let remembered = 0;
  const notice = createLiveChatAccessNotice({
    alreadyShown: () => false,
    show: (text) => shown.push(text),
    remember: async () => (remembered += 1),
  });
  notice();
  notice();
  notice();
  assert.deepEqual(shown, [LIVE_CHAT_ACCESS_NOTICE]);
  assert.equal(remembered, 1);

  const saved = createLiveChatAccessNotice({
    alreadyShown: () => true,
    show: (text) => shown.push(text),
    remember: async () => (remembered += 1),
  });
  saved();
  assert.equal(shown.length, 1);
  assert.equal(remembered, 1);

  // A failed save still shows it only once in this window.
  const failing = createLiveChatAccessNotice({
    alreadyShown: () => false,
    show: (text) => shown.push(text),
    remember: async () => {
      throw new Error("disk full");
    },
  });
  failing();
  failing();
  assert.equal(shown.length, 2);
});
