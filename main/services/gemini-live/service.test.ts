import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Credential } from "@earendil-works/pi-ai";
import type { LiveConnectParameters, LiveServerMessage } from "@google/genai";
import type { NotificationChannel } from "../../../renderer/preload-channels.js";
import type { AssistantLiveRendererEvent } from "../../../renderer/shared/assistant-live.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import { FakeGeminiLiveServer } from "./fake-live-server.js";
import { GeminiLiveService, GeminiLiveStartError } from "./service.js";
import { GeminiLiveComputerUseBridge } from "./computer-use-bridge.js";
import type { GeminiLiveComputerUseController } from "./computer-use-bridge.js";
import { ComputerUseParameters } from "../computer-use/schema.js";

class FakeOwner implements RendererDocumentOwner {
  destroyed = false;
  readonly events: AssistantLiveRendererEvent[] = [];
  private readonly invalidation = new Set<() => void>();

  constructor(
    readonly id: number,
    readonly documentId: string,
  ) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: NotificationChannel, payload: unknown): void {
    assert.equal(channel, "assistant-live:event");
    this.events.push(payload as AssistantLiveRendererEvent);
  }

  onInvalidated(listener: () => void): () => void {
    this.invalidation.add(listener);
    if (this.destroyed) listener();
    return () => this.invalidation.delete(listener);
  }

  navigate(): void {
    this.destroyed = true;
    for (const listener of [...this.invalidation]) listener();
  }
}

function serviceHarness(credential: Credential | null = { type: "api_key", key: "KEY_SENTINEL" }) {
  const servers: FakeGeminiLiveServer[] = [];
  const connectorKeys: string[] = [];
  let sequence = 0;
  const service = new GeminiLiveService({
    credentials: { read: async () => credential ?? undefined },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createSessionId: () => `session-${++sequence}`,
    createConnector: (apiKey) => {
      connectorKeys.push(apiKey);
      const server = new FakeGeminiLiveServer();
      servers.push(server);
      return server.connector;
    },
  });
  return { connectorKeys, servers, service };
}

const intent = { microphone: false, computerUseAuthorization: null } as const;

test("every stopped and restarted Live session gets a fresh dedicated thread", async () => {
  const server = new FakeGeminiLiveServer();
  const began: string[] = [];
  const finished: Array<{ id: string; outcome: string }> = [];
  let sequence = 0;
  const service = new GeminiLiveService({
    credentials: { read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }) },
    resolveModel: () => "gemini-3.8-live",
    createSessionId: () => `aiden-live-${++sequence}`,
    createConnector: () => server.connector,
    threads: {
      begin: async ({ id }) => {
        began.push(id);
      },
      finish: async (id, outcome) => {
        finished.push({ id, outcome });
      },
    },
  });
  const owner = new FakeOwner(2, "2:1:aiden-live-threads");

  await service.start(owner, intent);
  await service.stop(owner);
  await service.start(owner, intent);
  await service.stop(owner);

  assert.deepEqual(began, ["aiden-live-1", "aiden-live-2"]);
  assert.deepEqual(finished, [
    { id: "aiden-live-1", outcome: "stopped" },
    { id: "aiden-live-2", outcome: "stopped" },
  ]);
});

test("shutdown retries a failed thread finalization after the session has stopped", async () => {
  const server = new FakeGeminiLiveServer();
  let finishAttempts = 0;
  const service = new GeminiLiveService({
    credentials: { read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }) },
    resolveModel: () => "gemini-3.8-live",
    createSessionId: () => "retry-thread",
    createConnector: () => server.connector,
    threads: {
      begin: async () => undefined,
      finish: async () => {
        finishAttempts += 1;
        if (finishAttempts === 1) throw new Error("temporary disk failure");
      },
    },
  });
  const owner = new FakeOwner(22, "22:1:retry-thread");
  await service.start(owner, intent);
  await service.stop(owner);
  assert.equal(finishAttempts, 1);
  await service.shutdown();
  assert.equal(finishAttempts, 2);
});

test("shutdown waits for an in-flight thread begin and finalizes its record", async () => {
  const beginStarted = deferred<void>();
  const releaseBegin = deferred<void>();
  let began = false;
  const finished: string[] = [];
  const service = new GeminiLiveService({
    credentials: { read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }) },
    resolveModel: () => "gemini-3.8-live",
    createSessionId: () => "shutdown-during-begin",
    createConnector: () => new FakeGeminiLiveServer().connector,
    threads: {
      begin: async () => {
        beginStarted.resolve();
        await releaseBegin.promise;
        began = true;
      },
      finish: async (id) => {
        assert.equal(began, true);
        finished.push(id);
      },
    },
  });
  const start = service.start(new FakeOwner(23, "23:1:shutdown-begin"), intent);
  await beginStarted.promise;
  const shutdown = service.shutdown();
  releaseBegin.resolve();
  await assert.rejects(start, /Live session could not start/u);
  await shutdown;
  assert.deepEqual(finished, ["shutdown-during-begin"]);
});

test("explicit acceptance recorder corroborates ready, provider audio, and Stop teardown", async () => {
  const server = new FakeGeminiLiveServer();
  const evidence: string[] = [];
  const service = new GeminiLiveService({
    credentials: { read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }) },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createConnector: () => server.connector,
    acceptanceEvidence: { record: (event) => evidence.push(event) },
  });
  const owner = new FakeOwner(3, "100:6:acceptance-evidence");
  await service.start(owner, intent);
  server.latest.emit({
    setupComplete: {},
    serverContent: {
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: Buffer.from(new Uint8Array([1, 2])).toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
          },
        ],
      },
    },
  });
  service.stop(owner);
  assert.deepEqual(evidence, ["ready", "provider_response", "stop_requested", "stopped"]);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("fake transport projects bounded playback while secrets and tool arguments never cross IPC", async () => {
  const subject = serviceHarness();
  const owner = new FakeOwner(4, "100:7:doc-a");
  const started = await subject.service.start(owner, intent);

  assert.equal(started.sessionId, "session-1");
  assert.equal(started.model, "gemini-3.1-flash-live-preview");
  assert.deepEqual(subject.connectorKeys, ["KEY_SENTINEL"]);
  const server = subject.servers[0]!;
  server.latest.emit({
    setupComplete: {},
    serverContent: {
      inputTranscription: { text: "caption-safe", finished: true },
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
          },
        ],
      },
    },
    toolCall: {
      functionCalls: [
        {
          id: "call-1",
          name: "computer_use",
          args: { secretPrompt: "RAW_TOOL_SENTINEL" },
        },
      ],
    },
  });

  assert.ok(owner.events.some((event) => event.type === "ready"));
  assert.ok(
    owner.events.some(
      (event) => event.type === "caption" && event.text === "caption-safe" && event.final,
    ),
  );
  const audio = owner.events.find((event) => event.type === "audio");
  assert.ok(audio?.pcm instanceof Uint8Array);
  assert.deepEqual(audio?.pcm, Uint8Array.from([1, 2, 3, 4]));
  const serialized = JSON.stringify(owner.events);
  assert.doesNotMatch(serialized, /KEY_SENTINEL|RAW_TOOL_SENTINEL|AQIDBA==/u);
  assert.doesNotMatch(serialized, /"args"|"apiKey"|"credential"/u);
  await subject.service.shutdown();
});

test("only a prepared gated session declares and executes Aiden custom computer_use", async () => {
  const server = new FakeGeminiLiveServer();
  const preparedRequests: boolean[] = [];
  const executed: string[] = [];
  const closed: string[] = [];
  const controller: GeminiLiveComputerUseController = {
    approvalFor: async () => null,
    authorize: () => undefined,
    execute: async (id, args) => {
      executed.push(id);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        details: { action: args.action },
      };
    },
    close: async () => {
      closed.push("controller");
    },
  };
  const service = new GeminiLiveService({
    credentials: { read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }) },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createConnector: () => server.connector,
    prepareComputerUse: async ({ authorization, sessionId }) => {
      preparedRequests.push(Boolean(authorization));
      if (!authorization) return null;
      let sendResult:
        | ((value: { id: string; name: string; response: Record<string, unknown> }) => void)
        | null = null;
      const bridge = new GeminiLiveComputerUseBridge({
        sessionId,
        controller,
        isAuthorized: () => true,
        requestApproval: async () => true,
        sendResult: (value) => sendResult?.(value),
      });
      return {
        bridge,
        tools: [
          {
            functionDeclarations: [
              { name: "computer_use", parametersJsonSchema: ComputerUseParameters },
            ],
          },
        ],
        approve: () => false,
        bindSendResult: (send) => {
          sendResult = send;
        },
      };
    },
  });
  const owner = new FakeOwner(40, "40:1:live-tools");
  await service.start(owner, { microphone: false, computerUseAuthorization: null });
  assert.equal(server.latest.params.config?.tools, undefined);
  service.stop(owner);

  await service.start(owner, { microphone: false, computerUseAuthorization: "authorization" });
  const tool = server.latest.params.config?.tools?.[0] as
    | { functionDeclarations?: Array<{ name?: string; parametersJsonSchema?: unknown }> }
    | undefined;
  const declaration = tool?.functionDeclarations?.[0];
  assert.equal(declaration?.name, "computer_use");
  assert.equal(declaration?.parametersJsonSchema, ComputerUseParameters);
  server.latest.emit({
    toolCall: {
      functionCalls: [{ id: "live-call", name: "computer_use", args: { action: "list_apps" } }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executed, ["live-call"]);
  assert.equal(
    server.latest.received.some(
      (message) =>
        message.type === "tool_response" &&
        message.value.functionResponses &&
        !Array.isArray(message.value.functionResponses) &&
        message.value.functionResponses.id === "live-call",
    ),
    true,
  );
  service.revokeComputerUse();
  assert.deepEqual(closed, ["controller"]);
  assert.equal(server.latest.closed, true, "gate withdrawal terminates the whole Live session");
  assert.equal(service.sessions.values().length, 0);
  assert.equal(
    owner.events.some((event) => event.type === "snapshot" && event.snapshot.state === "closed"),
    true,
    "the renderer receives a terminal state for manual restart",
  );
  service.stop(owner);
  assert.deepEqual(preparedRequests, [false, true]);
  assert.deepEqual(closed, ["controller"]);
});

test("a Computer Use result produced during transport rotation fails the session closed", async () => {
  const server = new FakeGeminiLiveServer();
  const execution = deferred<Awaited<ReturnType<GeminiLiveComputerUseController["execute"]>>>();
  let bridge!: GeminiLiveComputerUseBridge;
  let controllerCloses = 0;
  const controller: GeminiLiveComputerUseController = {
    approvalFor: async () => null,
    authorize: () => undefined,
    execute: async () => execution.promise,
    close: async () => {
      controllerCloses += 1;
    },
  };
  const service = new GeminiLiveService({
    credentials: { read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }) },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createConnector: () => server.connector,
    prepareComputerUse: async ({ authorization, sessionId }) => {
      if (!authorization) return null;
      let sendResult:
        | ((value: { id: string; name: string; response: Record<string, unknown> }) => void)
        | null = null;
      bridge = new GeminiLiveComputerUseBridge({
        sessionId,
        controller,
        isAuthorized: () => true,
        requestApproval: async () => true,
        sendResult: (value) => sendResult?.(value),
      });
      return {
        bridge,
        tools: [
          {
            functionDeclarations: [
              { name: "computer_use", parametersJsonSchema: ComputerUseParameters },
            ],
          },
        ],
        approve: () => false,
        bindSendResult: (send) => {
          sendResult = send;
        },
      };
    },
  });
  const owner = new FakeOwner(42, "42:1:tool-rotation");
  await service.start(owner, {
    microphone: false,
    computerUseAuthorization: "authorization",
  });
  server.latest.emit({
    toolCall: {
      functionCalls: [
        { id: "rotating-call", name: "computer_use", args: { action: "list_apps" } },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const session = service.sessions.get(owner)!;
  session.state = "resuming";
  const protocol = session.protocol as unknown as { phase: string; wire: unknown };
  protocol.phase = "resuming";
  protocol.wire = null;
  execution.resolve({
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    details: { action: "list_apps" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.sessions.values().length, 0);
  assert.equal(protocol.phase, "closed");
  assert.equal(bridge.pendingCount, 0);
  assert.equal(controllerCloses, 1);
  assert.equal(
    owner.events.some((event) => event.type === "snapshot" && event.snapshot.state === "closed"),
    true,
    "the renderer receives a terminal state instead of a hanging function call",
  );
});

test("gate revocation aborts issued approval and queued calls before controller and socket teardown", async () => {
  const server = new FakeGeminiLiveServer();
  const order: string[] = [];
  const executed: string[] = [];
  let bridge!: GeminiLiveComputerUseBridge;
  const controller: GeminiLiveComputerUseController = {
    approvalFor: async (args) =>
      args.action === "type"
        ? {
            toolName: "computer_use",
            summary: "type into exact target",
            target: { pid: 7, windowId: 11 },
            grant: {} as never,
          }
        : null,
    authorize: () => undefined,
    execute: async (id, args) => {
      executed.push(id);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        details: { action: args.action },
      };
    },
    close: async () => {
      order.push("controller-close");
    },
  };
  const service = new GeminiLiveService({
    credentials: { read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }) },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createConnector: () => async (params) => {
      const connection = await server.connector(params);
      return {
        ...connection,
        close: () => {
          order.push("socket-close");
          connection.close();
        },
      };
    },
    prepareComputerUse: async ({ authorization, sessionId }) => {
      if (!authorization) return null;
      let sendResult:
        | ((value: { id: string; name: string; response: Record<string, unknown> }) => void)
        | null = null;
      bridge = new GeminiLiveComputerUseBridge({
        sessionId,
        controller,
        isAuthorized: () => true,
        requestApproval: ({ signal }) =>
          new Promise<boolean>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                order.push("approval-abort");
                resolve(false);
              },
              { once: true },
            );
          }),
        sendResult: (value) => sendResult?.(value),
      });
      return {
        bridge,
        tools: [
          {
            functionDeclarations: [
              { name: "computer_use", parametersJsonSchema: ComputerUseParameters },
            ],
          },
        ],
        approve: () => false,
        bindSendResult: (send) => {
          sendResult = send;
        },
      };
    },
  });
  class OrderingOwner extends FakeOwner {
    override send(channel: NotificationChannel, payload: unknown): void {
      const event = payload as AssistantLiveRendererEvent;
      if (event.type === "snapshot" && event.snapshot.state === "closed") {
        order.push("renderer-terminal");
      }
      super.send(channel, payload);
    }
  }
  const owner = new OrderingOwner(41, "41:1:live-revocation");
  await service.start(owner, {
    microphone: true,
    computerUseAuthorization: "authorization",
  });
  server.latest.emit({
    toolCall: {
      functionCalls: [
        { id: "issued", name: "computer_use", args: { action: "type", text: "hello" } },
        { id: "queued", name: "computer_use", args: { action: "wait", seconds: 0 } },
      ],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    bridge.pendingCount,
    2,
    "one approval is active while another issued call is queued",
  );

  service.revokeComputerUse();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(executed, [], "neither the pending mutation nor queued call may execute");
  assert.deepEqual(order, [
    "approval-abort",
    "controller-close",
    "renderer-terminal",
    "socket-close",
  ]);
  assert.equal(bridge.pendingCount, 0);
  assert.equal(service.sessions.values().length, 0);
  assert.equal(
    owner.events.some((event) => event.type === "snapshot" && event.snapshot.state === "closed"),
    true,
  );
});

test("session replacement closes the old transport before the replacement owns the document", async () => {
  let service!: GeminiLiveService;
  let connections = 0;
  let ownershipDuringFirstClose: readonly string[] | undefined;
  service = new GeminiLiveService({
    credentials: {
      read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }),
    },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createSessionId: () => `session-${connections + 1}`,
    createConnector: () => async () => {
      connections += 1;
      const connection = connections;
      return {
        close: () => {
          if (connection === 1) {
            ownershipDuringFirstClose = service.sessions
              .values()
              .map((session) => session.sessionId);
          }
        },
        sendClientContent: () => undefined,
        sendRealtimeInput: () => undefined,
        sendToolResponse: () => undefined,
      };
    },
  });
  const owner = new FakeOwner(8, "200:9:same-doc");
  const first = await service.start(owner, intent);
  const second = await service.start(owner, intent);

  assert.equal(first.sessionId, "session-1");
  assert.equal(second.sessionId, "session-2");
  assert.deepEqual(
    ownershipDuringFirstClose,
    [],
    "the previous session must be deleted before replacement is installed",
  );
  assert.deepEqual(
    service.sessions.values().map((session) => session.sessionId),
    ["session-2"],
  );
  await service.shutdown();
});

test("pending start replacement suppresses stale events and cannot reclaim exact-document ownership", async () => {
  const firstConnection = deferred<{
    close(): void;
    sendClientContent(): void;
    sendRealtimeInput(): void;
    sendToolResponse(): void;
  }>();
  let connectorCalls = 0;
  let firstParams: LiveConnectParameters | undefined;
  let lateFirstCloseCount = 0;
  let secondCloseCount = 0;
  const service = new GeminiLiveService({
    credentials: {
      read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }),
    },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createSessionId: () => `session-${connectorCalls + 1}`,
    createConnector: () => async (params) => {
      connectorCalls += 1;
      if (connectorCalls === 1) {
        firstParams = params;
        return firstConnection.promise;
      }
      return {
        close: () => {
          secondCloseCount += 1;
        },
        sendClientContent: () => undefined,
        sendRealtimeInput: () => undefined,
        sendToolResponse: () => undefined,
      };
    },
  });
  const owner = new FakeOwner(81, "201:9:same-doc");
  const firstStart = service.start(owner, intent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(firstParams, "the first start must reach its pending connector");

  const second = await service.start(owner, intent);
  firstParams.callbacks.onmessage({
    serverContent: {
      inputTranscription: { text: "STALE_EVENT_SENTINEL", finished: true },
    },
  } as unknown as LiveServerMessage);
  firstConnection.resolve({
    close: () => {
      lateFirstCloseCount += 1;
    },
    sendClientContent: () => undefined,
    sendRealtimeInput: () => undefined,
    sendToolResponse: () => undefined,
  });

  await assert.rejects(
    firstStart,
    (error: unknown) =>
      error instanceof GeminiLiveStartError && error.reason === "live_start_failed",
  );
  assert.equal(second.sessionId, "session-2");
  assert.equal(lateFirstCloseCount, 1, "the stale late transport must be closed");
  assert.equal(secondCloseCount, 0, "stale cleanup must not close the replacement");
  assert.doesNotMatch(JSON.stringify(owner.events), /STALE_EVENT_SENTINEL/u);
  assert.deepEqual(
    service.sessions.values().map((session) => session.sessionId),
    ["session-2"],
  );
  await service.shutdown();
});

test("navigation and owner loss close the exact document session", async () => {
  const subject = serviceHarness();
  const owner = new FakeOwner(9, "300:10:doc");
  await subject.service.start(owner, intent);
  const connection = subject.servers[0]!.latest;

  owner.navigate();

  assert.equal(connection.closed, true);
  assert.equal(subject.service.sessions.values().length, 0);
});

test("sessions are document-scoped and cannot be stopped by a different document", async () => {
  const subject = serviceHarness();
  const first = new FakeOwner(10, "400:11:first");
  const second = new FakeOwner(10, "400:12:second");
  await subject.service.start(first, intent);
  await subject.service.start(second, intent);

  subject.service.stop(new FakeOwner(10, "400:13:forged"));
  assert.equal(subject.servers[0]!.latest.closed, false);
  assert.equal(subject.servers[1]!.latest.closed, false);
  subject.service.stop(first);
  assert.equal(subject.servers[0]!.latest.closed, true);
  assert.equal(subject.servers[1]!.latest.closed, false);
  await subject.service.shutdown();
});

test("clean shutdown closes every transport and rejects new starts", async () => {
  const subject = serviceHarness();
  await subject.service.start(new FakeOwner(1, "1:1:a"), intent);
  await subject.service.start(new FakeOwner(2, "2:2:b"), intent);

  await subject.service.shutdown();

  assert.equal(subject.service.sessions.values().length, 0);
  assert.ok(subject.servers.every((server) => server.latest.closed));
  await assert.rejects(
    subject.service.start(new FakeOwner(3, "3:3:c"), intent),
    (error: unknown) =>
      error instanceof GeminiLiveStartError && error.reason === "live_start_failed",
  );
});

test("only a non-empty stored Google API-key credential is eligible", async () => {
  for (const [credential, reason] of [
    [null, "missing_google_credential"],
    [
      { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
      "google_oauth_unsupported",
    ],
    [{ type: "api_key" }, "google_api_key_invalid"],
    [{ type: "api_key", key: "   " }, "google_api_key_invalid"],
  ] as const) {
    const subject = serviceHarness(credential as Credential | null);
    const owner = new FakeOwner(20, `20:1:${reason}`);
    assert.equal((await subject.service.availability(owner)).reason, reason);
    await assert.rejects(
      subject.service.start(owner, intent),
      (error: unknown) => error instanceof GeminiLiveStartError && error.reason === reason,
    );
    assert.equal(subject.connectorKeys.length, 0);
  }
});

test("credential-store failures are normalized without exposing private detail", async () => {
  const service = new GeminiLiveService({
    credentials: {
      read: async () => {
        throw new Error("/Users/private/pi-provider-credentials.json KEY_SENTINEL");
      },
    },
    resolveModel: () => "gemini-3.1-flash-live-preview",
    createConnector: () => {
      throw new Error("connector must stay unreachable");
    },
  });
  assert.deepEqual(await service.availability(new FakeOwner(22, "22:1:doc")), {
    available: false,
    reason: "google_api_key_invalid",
    state: "idle",
  });
  await assert.rejects(service.start(new FakeOwner(22, "22:2:doc"), intent), (error: unknown) =>
    Boolean(
      error instanceof GeminiLiveStartError &&
      error.reason === "google_api_key_invalid" &&
      !error.message.includes("KEY_SENTINEL") &&
      !error.message.includes("/Users/private"),
    ),
  );
});

test("model resolver sync and async failures return one safe unavailable status", async () => {
  for (const resolveModel of [
    () => {
      throw new Error("wss://provider.example KEY_SENTINEL SYNC_MODEL_SENTINEL");
    },
    async () => {
      throw new Error("wss://provider.example KEY_SENTINEL ASYNC_MODEL_SENTINEL");
    },
  ]) {
    const service = new GeminiLiveService({
      credentials: {
        read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }),
      },
      resolveModel,
      createConnector: () => {
        throw new Error("connector must stay unreachable");
      },
    });

    const status = await service.availability(new FakeOwner(221, "221:1:doc"));
    assert.deepEqual(status, {
      available: false,
      reason: "live_model_unverified",
      state: "idle",
    });
    assert.doesNotMatch(
      JSON.stringify(status),
      /provider\.example|KEY_SENTINEL|SYNC_MODEL_SENTINEL|ASYNC_MODEL_SENTINEL/u,
    );
  }
});

test("connector factory throws and connector rejects are normalized without leaking provider detail", async () => {
  let connectorCase = 0;
  for (const createConnector of [
    () => {
      throw new Error("wss://provider.example KEY_SENTINEL FACTORY_SENTINEL");
    },
    () => async () => {
      throw new Error("wss://provider.example KEY_SENTINEL REJECTION_SENTINEL");
    },
  ]) {
    connectorCase += 1;
    const owner = new FakeOwner(23, `23:1:connector-${connectorCase}`);
    const service = new GeminiLiveService({
      credentials: {
        read: async () => ({ type: "api_key", key: "KEY_SENTINEL" }),
      },
      resolveModel: () => "gemini-3.1-flash-live-preview",
      createConnector,
    });
    await assert.rejects(service.start(owner, intent), (error: unknown) => {
      assert.ok(error instanceof GeminiLiveStartError);
      assert.equal(error.reason, "live_start_failed");
      assert.equal(error.message, "The Live session could not start.");
      assert.doesNotMatch(error.message, /provider\.example|KEY_SENTINEL|SENTINEL/u);
      return true;
    });
    assert.doesNotMatch(
      JSON.stringify(owner.events),
      /provider\.example|KEY_SENTINEL|SENTINEL/u,
      "safe internal event projection must not expose connector diagnostics",
    );
    if (connectorCase === 2) {
      assert.ok(
        owner.events.some(
          (event) =>
            event.type === "error" &&
            event.code === "transport_error" &&
            event.message === "The Live connection failed.",
        ),
        "the protocol's fixed safe transport event must remain projected",
      );
    }
    assert.equal(service.sessions.values().length, 0);
  }
});

test("the model gate is explicit-experimental and media has no persistence or logger dependency", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const [mainSource, serviceSource, handlerSource] = await Promise.all([
    fs.readFile(path.join(here, "service-main.ts"), "utf8"),
    fs.readFile(path.join(here, "service.ts"), "utf8"),
    fs.readFile(path.join(here, "../../handlers/assistant-live.ts"), "utf8"),
  ]);
  assert.match(mainSource, /resolveModel: \(\) => experimentalGeminiLiveModel\(\)/u);
  assert.match(mainSource, /behavior: Behavior\.NON_BLOCKING/u);
  assert.match(mainSource, /say Allow once or Deny/u);
  assert.doesNotMatch(serviceSource, /DataStore|writeFile|appendFile|logger|writeDevLog/u);
  assert.doesNotMatch(handlerSource, /jpeg|frame|credential|apiKey|tool/u);
});

test("microphone PCM is admitted only for the current consenting exact-document session", async () => {
  const subject = serviceHarness();
  const owner = new FakeOwner(31, "31:1:doc");
  const session = await subject.service.start(owner, {
    microphone: true,
    computerUseAuthorization: null,
  });
  const pcm = new Uint8Array(640);
  assert.equal(subject.service.sendAudio(owner, session.sessionId!, pcm), true);
  const received = subject.servers[0]!.latest.received;
  assert.equal(received[received.length - 1]?.type, "realtime_input");
  const beforeResumptionBuffer = received.length;
  const owned = subject.service.sessions.get(owner)!;
  owned.state = "resuming";
  assert.equal(subject.service.sendAudio(owner, session.sessionId!, pcm), true);
  assert.equal(
    received.length,
    beforeResumptionBuffer,
    "resumption buffers PCM until the replacement transport is open",
  );
  (
    subject.service as unknown as {
      handleProtocolEvent(
        session: typeof owned,
        event: { type: "state"; state: "open" },
      ): void;
    }
  ).handleProtocolEvent(owned, { type: "state", state: "open" });
  assert.equal(received.length, beforeResumptionBuffer + 1);
  owned.state = "resuming";
  for (let packet = 0; packet < 55; packet += 1) {
    const marked = new Uint8Array(640);
    marked[0] = packet;
    assert.equal(subject.service.sendAudio(owner, session.sessionId!, marked), true);
  }
  assert.equal(owned.resumptionAudio.length, 50);
  assert.equal(owned.resumptionAudio[0]?.[0], 5, "latest one second wins");
  owned.state = "open";
  assert.equal(subject.service.sendAudio(owner, "stale-session", pcm), false);
  assert.equal(
    subject.service.sendAudio(new FakeOwner(31, "31:2:other"), session.sessionId!, pcm),
    false,
  );
  await subject.service.shutdown();

  const noMic = serviceHarness();
  const noMicOwner = new FakeOwner(32, "32:1:doc");
  const noMicSession = await noMic.service.start(noMicOwner, intent);
  assert.equal(noMic.service.sendAudio(noMicOwner, noMicSession.sessionId!, pcm), false);
  await noMic.service.shutdown();
});

test("Computer Use is absent unless the Live start explicitly requests it", async () => {
  const subject = serviceHarness();
  await subject.service.start(new FakeOwner(33, "33:1:doc"), {
    microphone: true,
    computerUseAuthorization: null,
  });
  assert.equal(subject.servers[0]?.latest.params.config?.tools, undefined);
  await subject.service.stop(new FakeOwner(33, "33:1:doc"));
});
