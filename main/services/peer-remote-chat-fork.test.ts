import assert from "node:assert/strict";
import test from "node:test";
import { AidenRemoteChatService } from "./aiden-remote-chats.js";
import { ChatForkError } from "./chat-fork-error.js";
import { FakeHost, FEATURES, UNHANDLED, setup } from "./peer-remote-chat-test-host.js";
import { PeerTransportError, type PeerRequest } from "./peer-transport.js";
import { ChatIntentLedger } from "../../renderer/lib/hosts/chat-intent-ledger.js";
import { ChatSessionControl } from "../../renderer/lib/hosts/chat-session-control.js";
import { HostChatControlError, hostResultValue, isOutcomeUnknown } from "../../renderer/lib/hosts/host-chat-adapter.js";
import type { Chat, ChatMessage } from "../../renderer/lib/types.js";

/**
 * Forking a chat on a paired Mac end to end: the pane's session control over
 * the renderer adapter, main's real live IPC handlers, operation builder and
 * response parsers, and the host's real chat service with its revision check,
 * replay ledger and attachment staging. The fork store and the summarizer
 * are stand-ins that copy and settle the way the real ones do.
 */

const FORK_FEATURES = [...FEATURES, "chat-fork-v1", "chat-fork-summary-v1"];

function source(): ChatMessage[] {
  return [
    { id: "u1", role: "user", content: "Why does the build fail?", createdAt: 1_100 },
    { id: "a1", role: "assistant", content: "A missing token.", createdAt: 1_200 },
    {
      id: "u2",
      role: "user",
      content: "Fix it.",
      createdAt: 1_300,
      attachments: [{ id: "stored-notes", name: "notes.txt", mimeType: "text/plain", kind: "text", size: 5, text: "notes" }],
    },
    { id: "a2", role: "assistant", content: "Fixed.", createdAt: 1_400 },
  ];
}

/**
 * Serves the fork and fork-summary routes from the host's real chat service.
 * `forks` is the host's chat store for the copies it made.
 */
function forkingHost(features = FORK_FEATURES) {
  const host = new FakeHost("host_b", source());
  host.features = features;
  const forks = new Map<string, Chat>();
  const forkRequests: PeerRequest[] = [];
  let dropForkAcks = 0;
  let failure: ChatForkError | undefined;
  const chatById = (id: string) => (id === host.chat.id ? host.chat : forks.get(id));
  const unused = {} as never;
  const chats = new AidenRemoteChatService({
    application: {
      list: async () => [{ id: host.chat.id, title: host.chat.title }, ...[...forks.values()].map(({ id, title }) => ({ id, title }))],
      get: async (id: string) => ({ chat: chatById(id) ?? null }),
    } as unknown as ConstructorParameters<typeof AidenRemoteChatService>[0]["application"],
    chatStore: unused,
    generation: unused,
    streams: unused,
    models: unused,
    bots: unused,
    botMutations: unused,
    forks: {
      service: {
        supportsSummaries: true,
        async fork(request, caller) {
          const refusal = failure;
          failure = undefined;
          if (refusal) throw refusal;
          const chat = chatById(request.chatId);
          if (!chat) throw new ChatForkError("not_found", "The chat is no longer available.");
          caller.assertSource?.(chat);
          caller.admitWorkspace(chat.workspaceId!).release();
          const { messageId, position } = request.forkAt!;
          const cut = chat.messages.findIndex((message) => message.id === messageId);
          if (cut < 0) throw new ChatForkError("message_not_found", "That message is no longer in this chat.");
          const id = `fork-${forks.size + 1}`;
          const kept = chat.messages
            .slice(0, position === "after" ? cut + 1 : cut)
            .map((message) => ({ ...message, id: `${id}-${message.id}` }));
          const forked: Chat = {
            ...chat,
            id,
            title: `${chat.title} (fork)`,
            messages: kept,
            forkedFrom: {
              chatId: chat.id,
              messageId,
              position,
              at: 5_000,
              ...(request.summary
                ? {
                    summary: {
                      state: "pending" as const,
                      afterMessageId: kept[kept.length - 1]!.id,
                      ...(request.summary.instructions ? { instructions: request.summary.instructions } : {}),
                    },
                  }
                : {}),
            },
          };
          forks.set(id, forked);
          return forked;
        },
      },
      admitWorkspace: () => ({ isAborted: () => false, release: () => undefined }),
      summaries: {
        retry: async (chatId) => settle(chatId, "failed", (lineage) => ({ ...lineage, summary: { ...lineage.summary!, state: "pending" } })),
        skip: async (chatId) => settle(chatId, "failed", ({ summary: _summary, ...lineage }) => lineage),
        cancel: (chatId) => {
          if (forks.get(chatId)?.forkedFrom?.summary?.state !== "pending") return false;
          void settle(chatId, "pending", (lineage) => ({ ...lineage, summary: { ...lineage.summary!, state: "failed", error: "Stopped." } }));
          return true;
        },
      },
    },
  });

  /** Moves a fork's summary on from `from`, or refuses like the real summarizer. */
  async function settle(chatId: string, from: "pending" | "failed", next: (lineage: NonNullable<Chat["forkedFrom"]>) => Chat["forkedFrom"]) {
    const fork = forks.get(chatId);
    if (fork?.forkedFrom?.summary?.state !== from) throw new Error("The fork summary changed.");
    const updated = { ...fork, forkedFrom: next(fork.forkedFrom), updatedAt: fork.updatedAt + 1 };
    forks.set(chatId, updated);
    return updated;
  }

  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  host.routes = async (input, deviceId) => {
    const url = new URL(input.path, "https://host.invalid");
    const fork = /^\/chats\/([^/]+)\/fork$/u.exec(url.pathname);
    if (fork && input.method === "POST") {
      forkRequests.push(input);
      const result = await chats.fork(deviceId, fork[1]!, input.revision ?? "", input.idempotencyKey ?? "", input.body);
      if (dropForkAcks > 0) {
        dropForkAcks -= 1;
        throw new PeerTransportError("unavailable");
      }
      return json(result);
    }
    const summary = /^\/chats\/([^/]+)\/fork-summary\/(retry|skip|cancel)$/u.exec(url.pathname);
    if (summary && input.method === "POST") {
      const [, chatId, action] = summary;
      if (action === "retry") return json(await chats.retryForkSummary(chatId!));
      if (action === "skip") return json(await chats.skipForkSummary(chatId!));
      return json(await chats.cancelForkSummary(chatId!));
    }
    const read = /^\/chats\/(fork-[^/]+)$/u.exec(url.pathname);
    if (read && (input.method ?? "GET") === "GET") return json(await chats.get(read[1]!));
    return UNHANDLED;
  };
  return {
    host,
    forks,
    forkRequests,
    dropNextForkAck: () => {
      dropForkAcks += 1;
    },
    /** The host's fork store refuses the next fork the way the real one does. */
    failNextFork: (error: ChatForkError) => {
      failure = error;
    },
  };
}

async function open(features?: string[]) {
  const fixture = forkingHost(features);
  const harness = await setup(fixture.host);
  await harness.open();
  const control = (chatId = "chat-1") => {
    const next = new ChatSessionControl(harness.adapter, { hostId: harness.adapter.hostId, chatId }, new ChatIntentLedger());
    next.attach();
    return next;
  };
  const revision = harness.transcript().transcript.revision ?? undefined;
  return { ...fixture, harness, control, revision };
}

function code(expected: string) {
  return (error: unknown) => error instanceof HostChatControlError && error.code === expected;
}

/** A refusal the host answered with `expected` as its error code. */
function remote(expected: string) {
  return (error: unknown) => error instanceof HostChatControlError && error.remoteCode === expected;
}

test("a fork whose answer is lost is retried under the same key and makes one copy on the host", async () => {
  const { host, forks, forkRequests, dropNextForkAck, harness, control, revision } = await open();
  try {
    const pane = control();
    dropNextForkAck();
    await assert.rejects(pane.fork({ messageId: "a1", position: "after" }, revision), isOutcomeUnknown);
    assert.equal(forks.size, 1, "the host made the fork before its answer was lost");

    const forked = await pane.fork({ messageId: "a1", position: "after" }, revision);
    assert.equal(forks.size, 1, "the retry replayed the first fork instead of copying again");
    assert.equal(forked.id, "fork-1");
    assert.equal(forked.title, "Release notes (fork)");
    assert.deepEqual(forked.forkedFrom, { chatId: "chat-1", messageId: "a1", position: "after", at: 5_000 });
    assert.equal(forked.prefill, undefined, "a fork after a reply hands nothing back to edit");
    assert.equal(forkRequests.length, 2);
    assert.equal(forkRequests[1]!.idempotencyKey, forkRequests[0]!.idempotencyKey);
    assert.equal(forkRequests[0]!.revision, revision);

    // A fork at another message is new work under a new key.
    await pane.fork({ messageId: "a2", position: "after" }, revision);
    assert.equal(forks.size, 2);
    assert.notEqual(forkRequests[2]!.idempotencyKey, forkRequests[0]!.idempotencyKey);
    assert.deepEqual(host.chat.messages.map((message) => message.id), ["u1", "a1", "u2", "a2"], "the source is untouched");
  } finally {
    harness.close();
  }
});

test("a fork against a chat that changed on the host is refused and copies nothing", async () => {
  const { host, forks, harness, control, revision } = await open();
  try {
    host.append({ id: "u3", role: "user", content: "One more thing", createdAt: 1_500 });
    await assert.rejects(control().fork({ messageId: "a1", position: "after" }, revision), remote("revision_conflict"));
    assert.equal(forks.size, 0);
  } finally {
    harness.close();
  }
});

test("editing a prompt in a fork hands its text back and stages its files on the fork", async () => {
  const { forks, harness, control, revision } = await open();
  try {
    const forked = await control().fork({ messageId: "u2", position: "before" }, revision);
    assert.equal(forked.prefill?.text, "Fix it.");
    assert.equal(forked.prefill?.attachmentIds.length, 1, "the prompt's file was staged for the fork");
    assert.deepEqual(forked.forkedFrom, { chatId: "chat-1", messageId: "u2", position: "before", at: 5_000 });
    assert.deepEqual(
      forks.get(forked.id)?.messages.map((message) => message.content),
      ["Why does the build fail?", "A missing token."],
      "the fork stops before the prompt being edited",
    );
  } finally {
    harness.close();
  }
});

test("a host without fork support refuses forks before anything is sent", async () => {
  const { forkRequests, harness, control, revision } = await open(FEATURES);
  try {
    assert.equal(harness.adapter.capabilities().has("fork"), false);
    await assert.rejects(control().fork({ messageId: "a1", position: "after" }, revision), code("unsupported"));
    assert.equal(forkRequests.length, 0);
  } finally {
    harness.close();
  }
});

test("a host that forks but cannot summarize refuses only the summary actions", async () => {
  const { forks, forkRequests, harness, control, revision } = await open([...FEATURES, "chat-fork-v1"]);
  try {
    const pane = control();
    await assert.rejects(pane.fork({ messageId: "a1", position: "after", summary: {} }, revision), code("unsupported"));
    assert.equal(forkRequests.length, 0);

    const forked = await pane.fork({ messageId: "a1", position: "after" }, revision);
    assert.equal(forks.size, 1);
    await assert.rejects(control(forked.id).forkSummary("skip"), code("unsupported"));
    await assert.rejects(control(forked.id).cancelForkSummary(), code("unsupported"));
  } finally {
    harness.close();
  }
});

test("a fork with a summary can be cancelled, retried and skipped from the paired Mac", async () => {
  const { forks, harness, control, revision } = await open();
  try {
    const forked = await control().fork({ messageId: "a1", position: "after", summary: { instructions: "the token" } }, revision);
    assert.deepEqual(forked.forkedFrom.summary, { state: "pending", afterMessageId: "fork-1-a1", instructions: "the token" });

    const fork = control(forked.id);
    assert.equal(await fork.cancelForkSummary(), true);
    assert.equal(forks.get(forked.id)?.forkedFrom?.summary?.state, "failed");
    assert.equal(await fork.cancelForkSummary(), false, "nothing is running once it stopped");

    // The fork's own read carries the summary the feed leaves out.
    const read = hostResultValue(await harness.adapter.forkLineage(forked.id));
    assert.equal(read.forkedFrom?.summary?.state, "failed");
    assert.equal(read.forkedFrom?.summary?.error, "Stopped.");

    const retried = await fork.forkSummary("retry");
    assert.equal(retried.forkedFrom?.summary?.state, "pending");
    assert.equal(retried.forkedFrom?.summary?.instructions, "the token", "a retry keeps the focus");
    assert.notEqual(retried.revision, read.revision);

    await assert.rejects(fork.forkSummary("skip"), remote("revision_conflict"), "only a failed summary can be skipped");
    await fork.cancelForkSummary();
    const skipped = await fork.forkSummary("skip");
    assert.equal(skipped.forkedFrom?.summary, undefined, "the fork continues as a plain fork");
    assert.equal(forks.get(forked.id)?.forkedFrom?.summary, undefined);
  } finally {
    harness.close();
  }
});

test("the host's refusals reach the pane with their codes and whether waiting helps", async () => {
  const { forks, failNextFork, harness, control, revision } = await open();
  try {
    failNextFork(new ChatForkError("busy", "A response is still running."));
    await assert.rejects(
      control().fork({ messageId: "a1", position: "after" }, revision),
      (error: unknown) => remote("operation_in_progress")(error) && (error as HostChatControlError).retryable === true,
    );

    failNextFork(new ChatForkError("unavailable", "Forking is turned off."));
    await assert.rejects(
      control().fork({ messageId: "a1", position: "after" }, revision),
      (error: unknown) => remote("operation_in_progress")(error) && (error as HostChatControlError).retryable !== true,
    );

    await assert.rejects(control().fork({ messageId: "gone", position: "after" }, revision), remote("not_found"));
    assert.equal(forks.size, 0);

    await assert.rejects(control().forkSummary("retry"), remote("not_found"), "a chat that isn't a summarized fork has no summary");
  } finally {
    harness.close();
  }
});
