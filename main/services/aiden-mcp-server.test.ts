import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpClient, StreamableHttpTransport, type CallToolResult } from "@earendil-works/pi-mcp";

import { AIDEN_MCP_BODY_LIMIT, AidenMcpHost } from "./aiden-mcp-server.js";
import { AidenMcpProvenanceLog, emptyAidenMcpProvenanceDocument, type AidenMcpProvenanceDocument } from "./aiden-mcp-provenance.js";
import { AidenMcpToolRunner, type AidenMcpLimits } from "./aiden-mcp-tools.js";
import { AidenRemoteChatService } from "./aiden-remote-chats.js";
import { analyticsSettled, captureAnalyticsEvents, type CapturedAnalyticsEvent } from "./analytics/test-support.js";
import { revokeAidenRemoteRuntimeDevice } from "./aiden-remote-revocation.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  type AidenRemoteStateDocument,
} from "./aiden-remote-state.js";
import { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import type { AidenRemoteWorkspaceProjection } from "./aiden-remote-workspaces.js";
import { BotMutationGate } from "./bot-mutation-gate.js";
import type { Chat, ChatMessage } from "./types.js";

type HeldRun = {
  chatId: string;
  approval(approvalId: string, toolName?: string): void;
  finish(text?: string): void;
};

const WORKSPACES: AidenRemoteWorkspaceProjection[] = [
  {
    id: "workspace-1",
    name: "Website",
    permission: "ask",
    memoryEnabled: true,
    hasFolder: true,
    isManagedWorktree: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    revision: "workspace-rev-1",
  },
  {
    id: "no-workspace-1",
    name: "Chat folder",
    permission: "ask",
    memoryEnabled: false,
    hasFolder: true,
    isManagedWorktree: false,
    noWorkspace: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    revision: "workspace-rev-2",
  },
  {
    id: "assistant",
    name: "Assistant",
    permission: "ask",
    memoryEnabled: false,
    hasFolder: false,
    isManagedWorktree: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    revision: "workspace-rev-3",
  },
];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/**
 * A real Remote registry, chat service and stream service behind a real MCP
 * listener on loopback. Only the model run is fake: it either answers at once
 * or stays running until the test finishes it.
 */
async function harness(options: {
  hold?: boolean;
  /** Awaited before a chat's provenance is recorded: between its durable create and its first turn. */
  beforeProvenance?: (chatId: string) => Promise<void>;
  limits?: Partial<AidenMcpLimits>;
  supported?: boolean;
  stored?: AidenRemoteStateDocument;
  defaultPort?: number;
} = {}) {
  let stored: unknown = options.stored ?? createDefaultAidenRemoteState(() => Buffer.alloc(24, 7));
  let random = 0;
  let clock = 1_000_000;
  const registry = new AidenRemoteStateRegistry(
    {
      load: async () => structuredClone(stored),
      save: async (document) => {
        stored = structuredClone(document);
      },
    },
    {
      now: () => clock,
      randomBytes: (size) => Buffer.alloc(size, ++random),
      deriveCredentialDigest: async (credential, salt) =>
        createHash("sha256").update(credential).update(salt).digest(),
    },
  );
  await registry.initialize();

  const chats = new Map<string, Chat>();
  const held = new Map<string, HeldRun>();
  const cancelled: string[] = [];
  const settled: Array<{ approvalId: string; decision: string }> = [];
  let generationStarts = 0;
  let lastText: unknown;

  const finishRun = (streamId: string, text = "Answer") => {
    const run = held.get(streamId);
    run?.finish(text);
  };

  const streams = new AidenRemoteStreamService({
    now: () => Date.now(),
    cancel: (streamId) => {
      cancelled.push(streamId);
      // The model stops and reports it, as a real run does.
      setImmediate(() => finishRun(streamId));
      return true;
    },
    approve: (approvalId, decision) => {
      settled.push({ approvalId, decision });
      return true;
    },
  });

  const stub = async (): Promise<never> => {
    throw new Error("not used by the MCP server");
  };
  const service = new AidenRemoteChatService({
    application: {
      list: async () => [...chats.values()].map((chat) => structuredClone(chat)),
      listRegular: async () => [...chats.values()].map((chat) => structuredClone(chat)),
      listSummaryMetadata: async () => [...chats.values()].map((chat) => structuredClone(chat)),
      get: async (id: string) => ({
        chat: chats.has(id) ? structuredClone(chats.get(id)!) : null,
        imageArtifactRecoveryPending: false,
        imageArtifactRecoveryUnavailable: false,
        reconciliation: null,
      }),
      create: async (input) => {
        const chat: Chat = {
          id: `chat-${chats.size + 1}`,
          title: "New chat",
          workspaceId: input.workspaceId,
          providerId: input.providerId ?? "provider-1",
          model: input.model ?? "model-1",
          createdAt: 1_000,
          updatedAt: 2_000,
          messages: [],
        };
        chats.set(chat.id, chat);
        return structuredClone(chat);
      },
      rename: stub,
      moveEmptyToWorkspace: stub,
      remove: stub,
    },
    chatStore: {
      get: async (id) => (chats.has(id) ? structuredClone(chats.get(id)!) : null),
      appendMessage: async (id, message, meta) => {
        const chat = chats.get(id);
        if (!chat || !meta?.isCurrent?.()) throw new Error("stale");
        chat.messages.push({
          id: message.id!,
          role: message.role,
          content: message.content,
          createdAt: 3_000,
        });
        chat.updatedAt += 1;
        return structuredClone(chat);
      },
    },
    generation: {
      beginChatTurn: () => {
        let active = true;
        return {
          isActive: () => active,
          reserveAppendPayload: () => undefined,
          reserveSkillPreparation: () => undefined,
          prepareSkillInvocation: () => undefined,
          settleAsyncWork: () => undefined,
          onReleased: () => undefined,
          release: () => {
            active = false;
          },
        };
      },
      start: async (streamId, params, owner, generationOptions) => {
        generationStarts += 1;
        lastText = (params as unknown as { content?: unknown }).content;
        generationOptions.onTurnAccepted();
        const chatId = (params as unknown as { chatId: string }).chatId;
        let finished = false;
        const run: HeldRun = {
          chatId,
          approval: (approvalId, toolName = "bash") =>
            owner.send("chat:approval", {
              approvalId,
              toolCallId: `call-${approvalId}`,
              toolName,
              summary: "Run the test suite",
            }),
          finish: (text = "Answer") => {
            // A run whose owner was released (its app was disconnected) reports nothing more.
            if (finished || owner.isDestroyed()) return;
            finished = true;
            const chat = chats.get(chatId)!;
            const assistant: ChatMessage = { id: `assistant-${streamId}`, role: "assistant", content: text, createdAt: 4_000 };
            chat.messages.push(assistant);
            owner.send("chat:done", { streamId, chat: structuredClone(chat) });
          },
        };
        held.set(streamId, run);
        if (!options.hold) run.finish();
        return true;
      },
    },
    streams,
    models: {
      resolve: async (providerId, modelId) => ({
        providerId: providerId ?? "provider-1",
        modelId: modelId ?? "model-1",
        thinkingLevels: ["low", "high"],
        supportsImages: true,
      }),
    },
    // One real Bot, so its chat classifies as a Bot chat rather than a missing one.
    bots: { get: async (id: string) => (id === "bot-1" ? ({ id: "bot-1", name: "Ada" } as never) : null) },
    botMutations: new BotMutationGate(),
    botTurnAuthorityPreflight: async () => undefined,
  });

  let provenanceDocument: AidenMcpProvenanceDocument = emptyAidenMcpProvenanceDocument();
  const provenance = new AidenMcpProvenanceLog({
    load: async () => structuredClone(provenanceDocument),
    save: async (document) => {
      provenanceDocument = structuredClone(document);
    },
  });
  const tools = new AidenMcpToolRunner({
    services: async () => ({ chats: service, streams, workspaces: { list: async () => ({ workspaces: WORKSPACES }) } }),
    acquireAuthorization: (appId, tracksMutationDrain) => registry.acquireDeviceAuthorization(appId, tracksMutationDrain),
    recordProvenance: async (chatId, entry) => {
      await options.beforeProvenance?.(chatId);
      return provenance.record(chatId, entry);
    },
    appVersion: "9.9.9",
    hostName: async () => "Studio Mac",
    now: () => clock,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const host = new AidenMcpHost({
    state: registry,
    tools,
    supported: () => options.supported ?? true,
    defaultPort: options.defaultPort ?? (await freePort()),
    revokeDevice: (deviceId) =>
      revokeAidenRemoteRuntimeDevice(
        { state: registry, streams, chats: service, workspaceOwners: { revokeDevice: () => undefined } },
        deviceId,
      ),
    appVersion: "9.9.9",
  });

  const clients: McpClient[] = [];
  /** An outside app, connected the way Claude Code or Codex connects (GET stream attempt included). */
  const connect = async (credential: string) => {
    const status = await host.status();
    const client = new McpClient({ name: "test-app", version: "1.0.0" });
    await client.connect(
      new StreamableHttpTransport({ url: status.url!, headers: { authorization: `Bearer ${credential}` } }),
    );
    clients.push(client);
    return {
      listTools: async () => ({ tools: await client.listTools() }),
      callTool: ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) =>
        client.callTool(name, args),
    };
  };

  return {
    registry,
    host,
    streams,
    chats,
    held,
    cancelled,
    settled,
    connect,
    stored: () => structuredClone(stored) as AidenRemoteStateDocument,
    provenance: () => structuredClone(provenanceDocument),
    generationStarts: () => generationStarts,
    lastText: () => lastText,
    advance: (ms: number) => {
      clock += ms;
    },
    async enable() {
      const status = await host.setEnabled(true);
      assert.equal(status.running, true);
      return status;
    },
    async close() {
      for (const client of clients) await client.close().catch(() => undefined);
      await host.stop();
    },
  };
}

function structured(result: unknown): Record<string, unknown> {
  const call = result as CallToolResult;
  assert.notEqual(call.isError, true, JSON.stringify(call.content));
  return call.structuredContent as Record<string, unknown>;
}

/** The MCP server's own usage events, as the analytics registry would keep them. */
function mcpEvents(captured: CapturedAnalyticsEvent[]) {
  return captured.filter(({ event }) => event.startsWith("mcp_"));
}

function refusal(result: unknown): string {
  const call = result as CallToolResult;
  assert.equal(call.isError, true);
  const first = call.content[0];
  assert.equal(first?.type, "text");
  return (first as { text: string }).text;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
});

/** A raw request, so tests can send the Host and Origin headers a browser would. */
function raw(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body ?? "";
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path ?? "/mcp",
        method: options.method ?? "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(options.chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(Buffer.byteLength(body)) }),
          ...options.headers,
        },
      },
      (response) => {
        responded = true;
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
          request.destroy();
        });
      },
    );
    let responded = false;
    request.once("error", (error: NodeJS.ErrnoException) => {
      // Once the answer is in, a hang-up on the rest of an oversized upload is expected.
      if (responded && (error.code === "EPIPE" || error.code === "ECONNRESET")) return;
      reject(error);
    });
    if (options.chunked) {
      const piece = Buffer.alloc(64 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (!responded && sent < AIDEN_MCP_BODY_LIMIT + piece.length) {
          sent += piece.length;
          if (!request.write(piece)) {
            request.once("drain", pump);
            return;
          }
        }
        request.end();
      };
      pump();
    } else {
      request.end(body);
    }
  });
}

test("the MCP server is off until turned on, keeps its port, and reports a busy saved port", async () => {
  const first = await harness();
  try {
    assert.deepEqual(await first.host.status(), { supported: true, enabled: false, running: false });
    const on = await first.enable();
    assert.equal(on.enabled, true);
    assert.equal(on.url, `http://127.0.0.1:${on.port}/mcp`);
    const off = await first.host.setEnabled(false);
    assert.equal(off.running, false);
    assert.equal(off.port, on.port);
    await first.enable();
  } finally {
    await first.close();
  }

  // After a restart the same URL keeps working for every connected app.
  const saved = first.stored();
  const second = await harness({ stored: saved });
  try {
    const status = await second.host.initialize();
    assert.equal(status.running, true);
    assert.equal(status.port, saved.mcpServer?.port);
  } finally {
    await second.close();
  }

  // Another app took the saved port: Aiden says so instead of moving silently.
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(saved.mcpServer!.port!, "127.0.0.1", resolve));
  const third = await harness({ stored: saved });
  try {
    const status = await third.host.initialize();
    assert.equal(status.running, false);
    assert.equal(status.problem, "port_in_use");
    assert.equal(status.port, saved.mcpServer?.port);
  } finally {
    await third.close();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test("a host without the MCP capability never starts the server or connects an app", async (t) => {
  const events = captureAnalyticsEvents(t);
  const unsupported = await harness({ supported: false });
  try {
    await assert.rejects(unsupported.host.setEnabled(true), /cannot run Aiden's MCP server/u);
    await assert.rejects(unsupported.host.issueApp({ name: "Codex", access: "read" }), /cannot run/u);
    assert.deepEqual(await unsupported.host.status(), { supported: false, enabled: false, running: false });
    await analyticsSettled();
    assert.deepEqual(mcpEvents(events), [], "an app that was never connected is not counted");
  } finally {
    await unsupported.close();
  }
});

test("a missing, wrong or revoked token gets 401 and no tool runs", async () => {
  const fixture = await harness();
  try {
    const { port } = await fixture.enable();
    const { credential, app } = await fixture.host.issueApp({ name: "Claude Code", access: "supervised" });
    for (const authorization of [undefined, `Bearer ${"x".repeat(43)}`, `Basic ${credential}`, credential]) {
      const response = await raw(port!, {
        body: INITIALIZE,
        ...(authorization ? { headers: { authorization } } : {}),
      });
      assert.equal(response.status, 401);
      assert.match(String(response.headers["www-authenticate"]), /^Bearer /u);
    }
    const client = await fixture.connect(credential);
    assert.ok((await client.listTools()).tools.length > 0);

    assert.equal(await fixture.host.revokeApp(app.id), true);
    const after = await raw(port!, { body: INITIALIZE, headers: { authorization: `Bearer ${credential}` } });
    assert.equal(after.status, 401);
    await assert.rejects(client.listTools());
    assert.equal(fixture.generationStarts(), 0);
  } finally {
    await fixture.close();
  }
});

test("a phone's or a Mac's Remote credential is refused on /mcp, and cannot be revoked as an app", async () => {
  const fixture = await harness();
  try {
    const { port } = await fixture.enable();
    for (const type of ["iphone", "mac"] as const) {
      const paired = await fixture.registry.issueDevice({
        name: type,
        type,
        clientVersion: "1",
        capabilities: ["server:read", "chat:read", "chat:write"],
      });
      const response = await raw(port!, { body: INITIALIZE, headers: { authorization: `Bearer ${paired.credential}` } });
      assert.equal(response.status, 401);
      // The app controls only disconnect outside apps.
      assert.equal(await fixture.host.revokeApp(paired.device.id), false);
      assert.equal((await fixture.registry.authenticate(paired.credential))?.revoked, false);
    }
  } finally {
    await fixture.close();
  }
});

test("a foreign Host or Origin is refused, so a web page cannot reach the server by DNS rebinding", async () => {
  const fixture = await harness();
  try {
    const { port } = await fixture.enable();
    const { credential } = await fixture.host.issueApp({ name: "Codex", access: "read" });
    const authorization = `Bearer ${credential}`;
    const refused: Array<Record<string, string>> = [
      { host: `attacker.example:${port}` },
      { host: "127.0.0.1" },
      { host: `127.0.0.1:${port! + 1}` },
      { host: `127.0.0.1:${port}`, origin: "https://attacker.example" },
      { host: `127.0.0.1:${port}`, origin: `http://attacker.example:${port}` },
      { host: `127.0.0.1:${port}`, origin: "null" },
    ];
    for (const headers of refused) {
      const response = await raw(port!, { body: INITIALIZE, headers: { authorization, ...headers } });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    // A browser preflight gets no CORS grant either.
    const preflight = await raw(port!, {
      method: "OPTIONS",
      headers: { origin: "https://attacker.example", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers["access-control-allow-origin"], undefined);

    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const response = await raw(port!, {
        body: INITIALIZE,
        headers: { authorization, host, origin: `http://${host}` },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
  } finally {
    await fixture.close();
  }
});

test("a request body over 1 MiB is refused before any tool runs", async () => {
  const fixture = await harness();
  try {
    const { port } = await fixture.enable();
    const { credential } = await fixture.host.issueApp({ name: "Codex", access: "supervised" });
    const authorization = `Bearer ${credential}`;
    const call = (text: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "aiden_chat_start",
          arguments: { clientRequestId: "request-0001", workspaceId: "workspace-1", text },
        },
      });
    const oversized = call("x".repeat(AIDEN_MCP_BODY_LIMIT));
    const declared = await raw(port!, { body: oversized, headers: { authorization } });
    assert.equal(declared.status, 413);
    // An upload that never declares its length is cut off at the limit too.
    const streamed = await raw(port!, { chunked: true, headers: { authorization } });
    assert.equal(streamed.status, 413);
    const malformed = await raw(port!, { body: "{", headers: { authorization } });
    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.body).error.code, -32700);
    assert.equal(fixture.chats.size, 0);
    assert.equal(fixture.generationStarts(), 0);
  } finally {
    await fixture.close();
  }
});

test("a Read app sees only read tools and cannot start, send or stop a turn", async (t) => {
  const events = captureAnalyticsEvents(t);
  const fixture = await harness({ hold: true });
  try {
    await fixture.enable();
    const writer = await fixture.connect((await fixture.host.issueApp({ name: "Writer", access: "supervised" })).credential);
    const started = structured(
      await writer.callTool({
        name: "aiden_chat_start",
        arguments: { clientRequestId: "writer-request-1", workspaceId: "workspace-1", text: "Hello" },
      }),
    );

    const reader = await fixture.connect((await fixture.host.issueApp({ name: "Reader", access: "read" })).credential);
    const listed = (await reader.listTools()).tools;
    assert.deepEqual(listed.map((tool) => tool.name).sort(), [
      "aiden_chat_list",
      "aiden_chat_read",
      "aiden_chat_wait",
      "aiden_server_info",
      "aiden_workspace_list",
    ]);
    assert.ok(listed.every((tool) => tool.annotations?.readOnlyHint === true));
    const info = structured(await reader.callTool({ name: "aiden_server_info", arguments: {} }));
    assert.deepEqual(info.app, { name: "Reader", access: "read" });
    assert.equal(info.computer, "Studio Mac");

    const readOnly = "This app is connected to Aiden with Read access, so it cannot start, send or stop turns.";
    assert.equal(
      refusal(
        await reader.callTool({
          name: "aiden_chat_start",
          arguments: { clientRequestId: "reader-request-1", workspaceId: "workspace-1", text: "Hi" },
        }),
      ),
      readOnly,
    );
    assert.equal(
      refusal(
        await reader.callTool({
          name: "aiden_chat_send",
          arguments: { clientRequestId: "reader-request-2", chatId: started.chatId, text: "Hi" },
        }),
      ),
      readOnly,
    );
    assert.equal(
      refusal(await reader.callTool({ name: "aiden_chat_stop", arguments: { chatId: started.chatId, runId: started.runId } })),
      readOnly,
    );
    assert.equal(fixture.chats.size, 1);
    assert.equal(fixture.generationStarts(), 1);
    assert.deepEqual(fixture.cancelled, []);
    // Each app is counted with its access level only; the refused start is not a chat.
    await analyticsSettled();
    assert.deepEqual(mcpEvents(events), [
      { event: "mcp_app_connected", props: { access: "supervised" } },
      { event: "mcp_chat_started", props: { model_choice: "default" } },
      { event: "mcp_app_connected", props: { access: "read" } },
    ]);

    // Reads work, and the no-workspace folders Aiden makes for one chat are not offered.
    const workspaces = structured(await reader.callTool({ name: "aiden_workspace_list", arguments: {} }));
    assert.deepEqual(workspaces.workspaces, [
      { id: "workspace-1", name: "Website", hasFolder: true, toolPermission: "ask" },
    ]);
    assert.equal(
      refusal(await reader.callTool({ name: "aiden_chat_read", arguments: { chatId: "chat 1" } })),
      "The arguments do not match the tool's schema.",
    );
  } finally {
    await fixture.close();
  }
});

test("aiden_chat_start with the same clientRequestId starts one chat and one turn", async (t) => {
  const events = captureAnalyticsEvents(t);
  const fixture = await harness();
  try {
    await fixture.enable();
    const { credential, app } = await fixture.host.issueApp({ name: "Claude Code", access: "supervised" });
    const client = await fixture.connect(credential);
    const args = { clientRequestId: "retry-request-1", workspaceId: "workspace-1", text: "Summarize the README" };
    const [first, second] = await Promise.all([
      client.callTool({ name: "aiden_chat_start", arguments: args }),
      client.callTool({ name: "aiden_chat_start", arguments: args }),
    ]);
    const third = await client.callTool({ name: "aiden_chat_start", arguments: args });
    assert.deepEqual(structured(second), structured(first));
    assert.deepEqual(structured(third), structured(first));
    assert.equal(fixture.chats.size, 1);
    assert.equal(fixture.generationStarts(), 1);
    const started = structured(first);
    assert.equal(started.state, "running");
    // One chat is counted once, however often the app retried it.
    await analyticsSettled();
    assert.deepEqual(mcpEvents(events), [
      { event: "mcp_app_connected", props: { access: "supervised" } },
      { event: "mcp_chat_started", props: { model_choice: "default" } },
    ]);

    const finished = structured(
      await client.callTool({ name: "aiden_chat_wait", arguments: { chatId: started.chatId, runId: started.runId } }),
    );
    assert.equal(finished.state, "done");
    assert.equal(finished.outcome, "completed");
    assert.equal((finished.reply as { text: string }).text, "Answer");

    const read = structured(await client.callTool({ name: "aiden_chat_read", arguments: { chatId: started.chatId } }));
    assert.deepEqual(
      (read.messages as Array<{ role: string; text: string }>).map(({ role, text }) => [role, text]),
      [
        ["user", "Summarize the README"],
        ["assistant", "Answer"],
      ],
    );

    // Which app started the chat is noted on this computer only, never in what any client reads.
    assert.deepEqual(fixture.provenance().entries.map(({ chatId, kind, appId, name }) => ({ chatId, kind, appId, name })), [
      { chatId: started.chatId, kind: "app", appId: app.id, name: "Claude Code" },
    ]);
    const list = await client.callTool({ name: "aiden_chat_list", arguments: {} });
    assert.equal(JSON.stringify(list).includes(app.id), false);
    assert.equal(JSON.stringify(read).includes(app.id), false);

    // Continuing a chat is not a new one.
    structured(
      await client.callTool({
        name: "aiden_chat_send",
        arguments: { clientRequestId: "retry-send-1", chatId: started.chatId, text: "And the tests?" },
      }),
    );
    // A different id is a different request.
    const another = structured(
      await client.callTool({
        name: "aiden_chat_start",
        arguments: { ...args, clientRequestId: "retry-request-2", providerId: "provider-2", modelId: "model-2" },
      }),
    );
    assert.notEqual(another.chatId, started.chatId);
    assert.equal(fixture.generationStarts(), 3);
    await analyticsSettled();
    const sent = mcpEvents(events);
    assert.deepEqual(sent.slice(2), [{ event: "mcp_chat_started", props: { model_choice: "chosen" } }]);
    // Nothing the app or the person typed, and no id, reaches the report.
    for (const secret of ["Summarize", "Claude Code", "workspace-1", "provider-2", "model-2", started.chatId, app.id, credential]) {
      assert.equal(JSON.stringify(sent).includes(String(secret)), false, String(secret));
    }
  } finally {
    await fixture.close();
  }
});

test("an approval waits for the person in Aiden; the app can see it but never answer it", async () => {
  const fixture = await harness({ hold: true });
  try {
    await fixture.enable();
    const { credential } = await fixture.host.issueApp({ name: "Claude Code", access: "supervised" });
    assert.equal((await fixture.registry.authenticate(credential))?.capabilities.has("approval:respond"), false);
    const client = await fixture.connect(credential);
    const started = structured(
      await client.callTool({
        name: "aiden_chat_start",
        arguments: { clientRequestId: "approval-request-1", workspaceId: "workspace-1", text: "Run the tests" },
      }),
    );
    const runId = started.runId as string;
    const waiting = client.callTool({ name: "aiden_chat_wait", arguments: { chatId: started.chatId, runId, timeoutSeconds: 20 } });
    setTimeout(() => fixture.held.get(runId)!.approval("approval-1"), 50);
    const approval = structured(await waiting);
    assert.equal(approval.state, "waiting_for_approval");
    assert.equal(approval.approveIn, "Aiden on Studio Mac");
    assert.equal((approval.approval as { toolName: string }).toolName, "bash");

    // There is no tool for it, and naming one does nothing.
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.some((name) => /approv|question|answer|respond/u.test(name)), false);
    for (const name of ["aiden_approval_respond", "aiden_chat_approve"]) {
      assert.equal(
        refusal(await client.callTool({ name, arguments: { approvalId: "approval-1", decision: "allow" } })),
        "Aiden has no tool with that name.",
      );
    }
    // Waiting again does not settle it either.
    const still = structured(
      await client.callTool({ name: "aiden_chat_wait", arguments: { chatId: started.chatId, runId, timeoutSeconds: 1 } }),
    );
    assert.equal(still.state, "waiting_for_approval");
    assert.deepEqual(fixture.settled, []);

    // The person allows it in Aiden on this computer, and the run carries on.
    assert.equal(fixture.streams.respondApprovalFromHost(started.chatId as string, "approval-1", "allow"), true);
    assert.deepEqual(fixture.settled, [{ approvalId: "approval-1", decision: "allow" }]);
    fixture.held.get(runId)!.finish("All green");
    const done = structured(await client.callTool({ name: "aiden_chat_wait", arguments: { chatId: started.chatId, runId } }));
    assert.equal(done.state, "done");
    assert.equal((done.reply as { text: string }).text, "All green");
  } finally {
    await fixture.close();
  }
});

test("an app stops only its own runs, and another app cannot see them", async () => {
  const fixture = await harness({ hold: true });
  try {
    await fixture.enable();
    const owner = await fixture.connect((await fixture.host.issueApp({ name: "Owner", access: "supervised" })).credential);
    const other = await fixture.connect((await fixture.host.issueApp({ name: "Other", access: "supervised" })).credential);
    const started = structured(
      await owner.callTool({
        name: "aiden_chat_start",
        arguments: { clientRequestId: "stop-request-1", workspaceId: "workspace-1", text: "Long job" },
      }),
    );
    const target = { chatId: started.chatId, runId: started.runId };
    const notTracked = "Aiden no longer tracks this run. Read the chat with aiden_chat_read for its result.";
    assert.equal(refusal(await other.callTool({ name: "aiden_chat_stop", arguments: target })), notTracked);
    assert.equal(refusal(await other.callTool({ name: "aiden_chat_wait", arguments: { ...target, timeoutSeconds: 1 } })), notTracked);
    assert.deepEqual(fixture.cancelled, []);

    assert.deepEqual(structured(await owner.callTool({ name: "aiden_chat_stop", arguments: target })), { ...target, stopped: true });
    assert.deepEqual(fixture.cancelled, [started.runId]);
    const stopped = structured(await owner.callTool({ name: "aiden_chat_wait", arguments: target }));
    assert.equal(stopped.state, "done");
    assert.equal(stopped.outcome, "stopped");
    // Stopping a finished run does nothing.
    assert.deepEqual(structured(await owner.callTool({ name: "aiden_chat_stop", arguments: target })), {
      ...target,
      stopped: false,
      state: "done",
    });
    assert.deepEqual(fixture.cancelled, [started.runId]);
  } finally {
    await fixture.close();
  }
});

test("disconnecting an app ends its wait, stops its run and retires its token", async () => {
  const fixture = await harness({ hold: true });
  try {
    await fixture.enable();
    const { credential, app } = await fixture.host.issueApp({ name: "Claude Code", access: "supervised" });
    const client = await fixture.connect(credential);
    const started = structured(
      await client.callTool({
        name: "aiden_chat_start",
        arguments: { clientRequestId: "revoke-request-1", workspaceId: "workspace-1", text: "Long job" },
      }),
    );
    const begun = Date.now();
    const waiting = client.callTool({
      name: "aiden_chat_wait",
      arguments: { chatId: started.chatId, runId: started.runId, timeoutSeconds: 30 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await fixture.host.revokeApp(app.id), true);
    assert.equal(refusal(await waiting), "This app was disconnected from Aiden.");
    assert.ok(Date.now() - begun < 10_000);
    assert.deepEqual(fixture.cancelled, [started.runId]);
    assert.equal((await fixture.host.listApps()).find((entry) => entry.id === app.id)?.revokedAt !== undefined, true);
    await assert.rejects(client.callTool({ name: "aiden_chat_list", arguments: {} }));
  } finally {
    await fixture.close();
  }
});

test("each app has its own turn rate limit and run cap, and a retry does not count twice", async () => {
  const fixture = await harness({ hold: true, limits: { turnsPerMinute: 3, concurrentRuns: 2 } });
  try {
    await fixture.enable();
    const client = await fixture.connect((await fixture.host.issueApp({ name: "Busy", access: "supervised" })).credential);
    const start = (id: string) =>
      client.callTool({ name: "aiden_chat_start", arguments: { clientRequestId: id, workspaceId: "workspace-1", text: "Go" } });

    const first = structured(await start("limit-request-1"));
    const second = structured(await start("limit-request-2"));
    // Replaying a request it already made is not a new turn.
    assert.deepEqual(structured(await start("limit-request-2")), second);
    assert.equal(
      refusal(await start("limit-request-3")),
      "This app already has 2 runs going in Aiden. Wait for one to finish or stop one first.",
    );
    fixture.held.get(first.runId as string)!.finish();
    await client.callTool({ name: "aiden_chat_wait", arguments: { chatId: first.chatId, runId: first.runId } });
    const third = structured(await start("limit-request-3"));
    fixture.held.get(third.runId as string)!.finish();
    await client.callTool({ name: "aiden_chat_wait", arguments: { chatId: third.chatId, runId: third.runId } });

    assert.equal(
      refusal(await start("limit-request-4")),
      "This app started 3 turns in the last minute. Try again in 60 seconds.",
    );
    assert.equal(
      refusal(
        await client.callTool({
          name: "aiden_chat_send",
          arguments: { clientRequestId: "limit-send-1", chatId: first.chatId, text: "More" },
        }),
      ),
      "This app started 3 turns in the last minute. Try again in 60 seconds.",
    );
    assert.equal(fixture.generationStarts(), 3);

    // Another app is not held back by this one.
    const neighbour = await fixture.connect((await fixture.host.issueApp({ name: "Calm", access: "supervised" })).credential);
    structured(
      await neighbour.callTool({
        name: "aiden_chat_start",
        arguments: { clientRequestId: "neighbour-request-1", workspaceId: "workspace-1", text: "Hi" },
      }),
    );

    fixture.advance(61_000);
    structured(await start("limit-request-4"));
    assert.equal(fixture.generationStarts(), 5);
  } finally {
    await fixture.close();
  }
});

test("a retry the server's request cache has forgotten still replays, without counting as a new turn", async (t) => {
  const events = captureAnalyticsEvents(t);
  const chatsStarted = () => mcpEvents(events).filter(({ event }) => event === "mcp_chat_started").length;
  // Room for exactly the first start, its send and 128 more: then the rate limit is spent.
  const fixture = await harness({ limits: { turnsPerMinute: 130, concurrentRuns: 130 } });
  try {
    await fixture.enable();
    const client = await fixture.connect((await fixture.host.issueApp({ name: "Retrier", access: "supervised" })).credential);
    const start = (id: string) =>
      client.callTool({ name: "aiden_chat_start", arguments: { clientRequestId: id, workspaceId: "workspace-1", text: "Go" } });
    const sendArgs = (chatId: unknown) => ({ clientRequestId: "evicted-send-1", chatId, text: "More" });

    const first = structured(await start("evicted-start-1"));
    await client.callTool({ name: "aiden_chat_wait", arguments: { chatId: first.chatId, runId: first.runId } });
    const sent = structured(await client.callTool({ name: "aiden_chat_send", arguments: sendArgs(first.chatId) }));
    // 128 newer requests push both out of the in-memory cache.
    for (let index = 0; index < 128; index += 1) structured(await start(`filler-start-${index}`));
    assert.equal(fixture.generationStarts(), 130);
    await analyticsSettled();
    assert.equal(chatsStarted(), 129);

    assert.deepEqual(structured(await start("evicted-start-1")), first);
    assert.deepEqual(structured(await client.callTool({ name: "aiden_chat_send", arguments: sendArgs(first.chatId) })), sent);
    assert.equal(fixture.generationStarts(), 130);
    // A new request is still held to the limit.
    assert.match(refusal(await start("fresh-start-1")), /started 130 turns in the last minute/u);
    // Neither the replay from Aiden's durable record nor the refused start is counted.
    await analyticsSettled();
    assert.equal(chatsStarted(), 129);
  } finally {
    await fixture.close();
  }
});

test("a start still running when 128 newer requests arrive is joined by its retry and counted once", async (t) => {
  const events = captureAnalyticsEvents(t);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = false;
  const fixture = await harness({
    limits: { turnsPerMinute: 200, concurrentRuns: 200 },
    // Only the original call waits: a retry that ran on its own would pass straight through.
    beforeProvenance: (chatId) => {
      if (chatId !== "chat-1" || gated) return Promise.resolve();
      gated = true;
      return held;
    },
  });
  try {
    await fixture.enable();
    const client = await fixture.connect((await fixture.host.issueApp({ name: "Retrier", access: "supervised" })).credential);
    const start = (id: string) =>
      client.callTool({ name: "aiden_chat_start", arguments: { clientRequestId: id, workspaceId: "workspace-1", text: "Go" } });

    // The first start has created its chat and waits before its first turn.
    const first = start("slow-start-1");
    while (fixture.chats.size === 0) await new Promise((resolve) => setImmediate(resolve));
    for (let index = 0; index < 128; index += 1) structured(await start(`filler-start-${index}`));
    // The retry gets as long as an independent start would need; it must not finish on its own.
    const retry = start("slow-start-1");
    await Promise.race([retry, delay(500)]);
    release();
    const [original, retried] = await Promise.all([first, retry]);
    assert.deepEqual(structured(retried), structured(original));
    assert.equal(fixture.generationStarts(), 129);
    await analyticsSettled();
    assert.equal(mcpEvents(events).filter(({ event }) => event === "mcp_chat_started").length, 129);
  } finally {
    await fixture.close();
  }
});

test("an app with 8 starts still unanswered is refused a new one, while a retry of a held start still joins it", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await harness({
    limits: { turnsPerMinute: 200, concurrentRuns: 200 },
    // Every start stalls after creating its chat, as a stuck store or a vanished client would leave it.
    beforeProvenance: () => held,
  });
  try {
    await fixture.enable();
    const client = await fixture.connect((await fixture.host.issueApp({ name: "Flooder", access: "supervised" })).credential);
    const start = (id: string) =>
      client.callTool({ name: "aiden_chat_start", arguments: { clientRequestId: id, workspaceId: "workspace-1", text: "Go" } });

    const stalled = Array.from({ length: 8 }, (_, index) => start(`stalled-start-${index}`));
    while (fixture.chats.size < 8) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      refusal(await start("one-too-many")),
      "This app has 8 requests Aiden is still answering. Wait for one to finish, then try again.",
    );
    const retry = start("stalled-start-0");
    release();
    const answers = await Promise.all(stalled);
    assert.deepEqual(structured(await retry), structured(answers[0]));
    assert.equal(fixture.generationStarts(), 8, "the refused start never ran");

    // Once they are answered the app may start again.
    structured(await start("after-the-flood"));
    assert.equal(fixture.generationStarts(), 9);
  } finally {
    await fixture.close();
  }
});

test("Bot chats and the folders Aiden makes for one chat are out of an app's reach", async () => {
  const fixture = await harness();
  try {
    await fixture.enable();
    fixture.chats.set("bot-chat-1", {
      id: "bot-chat-1",
      title: "Ada",
      workspaceId: "workspace-1",
      botId: "bot-1",
      createdAt: 1_000,
      updatedAt: 9_000,
      messages: [{ id: "bot-message-1", role: "assistant", content: "Private Bot note", createdAt: 1_500 }],
    } as Chat);
    const client = await fixture.connect((await fixture.host.issueApp({ name: "Codex", access: "supervised" })).credential);

    const listed = structured(await client.callTool({ name: "aiden_chat_list", arguments: {} }));
    assert.deepEqual(listed.chats, []);
    const missing = "This Aiden chat no longer exists.";
    assert.equal(refusal(await client.callTool({ name: "aiden_chat_read", arguments: { chatId: "bot-chat-1" } })), missing);
    assert.equal(
      refusal(
        await client.callTool({
          name: "aiden_chat_send",
          arguments: { clientRequestId: "bot-send-0001", chatId: "bot-chat-1", text: "Hi Ada" },
        }),
      ),
      missing,
    );

    for (const workspaceId of ["no-workspace-1", "assistant", "workspace-missing"]) {
      assert.equal(
        refusal(
          await client.callTool({
            name: "aiden_chat_start",
            arguments: { clientRequestId: `hidden-${workspaceId}`, workspaceId, text: "Hi" },
          }),
        ),
        "Aiden has no workspace with that id. List them with aiden_workspace_list.",
      );
    }
    assert.equal(fixture.chats.size, 1);
    assert.equal(fixture.chats.get("bot-chat-1")!.messages.length, 1);
    assert.equal(fixture.generationStarts(), 0);
  } finally {
    await fixture.close();
  }
});

test("assistant and design-project chats answer every chat tool exactly as an unknown chat does", async () => {
  const fixture = await harness();
  try {
    await fixture.enable();
    const hidden: Record<string, Partial<Chat>> = {
      "assistant-chat-1": { workspaceId: "assistant" },
      "design-chat-1": { workspaceId: "workspace-1", owner: { kind: "design-project", projectId: "project-1" } },
    };
    for (const [id, fields] of Object.entries(hidden)) {
      fixture.chats.set(id, {
        id,
        title: "Private",
        providerId: "provider-1",
        model: "model-1",
        createdAt: 1_000,
        updatedAt: 9_000,
        messages: [{ id: `${id}-message`, role: "assistant", content: "Private note", createdAt: 1_500 }],
        ...fields,
      } as Chat);
    }
    const client = await fixture.connect((await fixture.host.issueApp({ name: "Codex", access: "supervised" })).credential);
    assert.deepEqual(structured(await client.callTool({ name: "aiden_chat_list", arguments: {} })).chats, []);

    const answers = async (chatId: string) => [
      refusal(await client.callTool({ name: "aiden_chat_read", arguments: { chatId } })),
      refusal(await client.callTool({ name: "aiden_chat_wait", arguments: { chatId, runId: "run-1", timeoutSeconds: 1 } })),
      refusal(
        await client.callTool({
          name: "aiden_chat_send",
          arguments: { clientRequestId: `send-${chatId}`, chatId, text: "Hi" },
        }),
      ),
      refusal(await client.callTool({ name: "aiden_chat_stop", arguments: { chatId, runId: "run-1" } })),
    ];
    const unknown = await answers("chat-that-never-existed");
    assert.deepEqual(unknown, Array(4).fill("This Aiden chat no longer exists."));
    for (const id of Object.keys(hidden)) assert.deepEqual(await answers(id), unknown, id);

    for (const id of Object.keys(hidden)) assert.equal(fixture.chats.get(id)!.messages.length, 1);
    assert.equal(fixture.generationStarts(), 0);
  } finally {
    await fixture.close();
  }
});
