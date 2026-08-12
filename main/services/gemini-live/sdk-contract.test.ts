import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { GoogleGenAI, Modality } from "@google/genai";
import type { GeminiLiveWireSession } from "./protocol.js";
import {
  classifyGeminiLiveConnectionFailure,
  classifyGeminiLiveUpgradeFailure,
  GEMINI_LIVE_MAX_RAW_WEBSOCKET_PAYLOAD_BYTES,
  createOwnedGoogleGenAIConnector,
  GeminiLiveConnectionError,
} from "./owned-sdk-connector.js";
import { GeminiLiveProtocol } from "./protocol.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const modulesRoot = path.join(repositoryRoot, "node_modules");

interface LocalWebSocket {
  on(
    event: "message",
    listener: (payload: { toString(): string }) => void,
  ): this;
  on(event: "close", listener: () => void): this;
  send(payload: string): void;
  close(code?: number, data?: string): void;
  terminate(): void;
}

interface LocalWebSocketServer {
  address(): AddressInfo | string | null;
  close(callback: (error?: Error) => void): void;
  on(
    event: "connection",
    listener: (socket: LocalWebSocket, request: { url?: string }) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "listening", listener: () => void): this;
}

interface LocalWebSocketServerConstructor {
  new (options: { host: string; port: number }): LocalWebSocketServer;
}

function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out.`)),
      2_000,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("provider close diagnostics collapse to fixed content-free categories", () => {
  assert.equal(
    classifyGeminiLiveConnectionFailure(
      1008,
      "API key was reported as leaked: SECRET",
    ),
    "authentication",
  );
  assert.equal(
    classifyGeminiLiveConnectionFailure(
      1011,
      "RESOURCE_EXHAUSTED for private project 123",
    ),
    "quota",
  );
  assert.equal(
    classifyGeminiLiveConnectionFailure(
      1008,
      "Operation is not implemented or enabled",
    ),
    "unsupported_configuration",
  );
  assert.equal(
    classifyGeminiLiveConnectionFailure(1011, "Internal provider detail"),
    "service_unavailable",
  );
  assert.equal(
    classifyGeminiLiveConnectionFailure(
      1006,
      "wss://private.example?key=SECRET",
    ),
    "network",
  );
});

test("HTTP upgrade statuses collapse to fixed content-free categories", () => {
  assert.equal(classifyGeminiLiveUpgradeFailure(401), "authentication");
  assert.equal(classifyGeminiLiveUpgradeFailure(403), "authentication");
  assert.equal(classifyGeminiLiveUpgradeFailure(429), "quota");
  assert.equal(classifyGeminiLiveUpgradeFailure(503), "service_unavailable");
  assert.equal(
    classifyGeminiLiveUpgradeFailure(400),
    "unsupported_configuration",
  );
  assert.equal(classifyGeminiLiveUpgradeFailure(undefined), "network");
});

test("an HTTP upgrade rejection preserves its safe category", async () => {
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    }),
    "Upgrade-rejection server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const connector = createOwnedGoogleGenAIConnector({
      apiKey: "phase-zero-loopback-only",
      httpOptions: {
        apiVersion: "v1beta",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    });
    await assert.rejects(
      deadline(
        connector({
          model: "phase-zero-live-model",
          config: { responseModalities: [Modality.AUDIO] },
          callbacks: { onmessage: () => undefined },
        }),
        "Upgrade-rejection connector",
      ),
      (error: unknown) => {
        assert.ok(error instanceof GeminiLiveConnectionError);
        assert.equal(error.code, "authentication");
        return true;
      },
    );
  } finally {
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Upgrade-rejection server shutdown",
    );
  }
});

async function packageVersion(packageRoot: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string")
    throw new Error("Package version is unavailable.");
  return manifest.version;
}

test("uses the exact reviewed Google SDK without replacing Pi's own exact SDK", async () => {
  const directRoot = path.join(modulesRoot, "@google/genai");
  const piGoogleRoot = path.join(
    modulesRoot,
    "@earendil-works/pi-ai/node_modules/@google/genai",
  );

  assert.equal(await packageVersion(directRoot), "2.16.0");
  assert.equal(await packageVersion(piGoogleRoot), "1.52.0");
  assert.notEqual(directRoot, piGoogleRoot);
});

test("the installed Node runtime exposes Live without opening a provider connection", () => {
  const client = new GoogleGenAI({ apiKey: "phase-zero-fake-key-never-sent" });
  assert.equal(typeof client.live.connect, "function");
});

test("the installed SDK completes its real Node WebSocket setup against loopback only", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Local Live server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const messages: Array<Record<string, unknown>> = [];
  let serverSocket: LocalWebSocket | undefined;
  let requestUrl = "";
  let resolveRealtime!: () => void;
  let rejectRealtime!: (error: unknown) => void;
  const realtimeReceived = new Promise<void>((resolve, reject) => {
    resolveRealtime = resolve;
    rejectRealtime = reject;
  });
  let resolveToolResponse!: () => void;
  const toolResponseReceived = new Promise<void>((resolve) => {
    resolveToolResponse = resolve;
  });
  const serverEvents: unknown[] = [];
  server.on("connection", (socket, request) => {
    serverSocket = socket;
    requestUrl = request.url ?? "";
    socket.on("message", (payload) => {
      try {
        const parsed: unknown = JSON.parse(payload.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Local Live server received a non-object message.");
        }
        const message = parsed as Record<string, unknown>;
        messages.push(message);
        if ("setup" in message)
          socket.send(JSON.stringify({ setupComplete: {} }));
        if ("realtimeInput" in message) {
          resolveRealtime();
          socket.send(
            JSON.stringify({
              toolCall: {
                functionCalls: [
                  {
                    id: "wire-call-1",
                    name: "computer_use",
                    args: { action: "capture" },
                  },
                ],
              },
            }),
          );
        }
        if ("toolResponse" in message) resolveToolResponse();
      } catch (error) {
        rejectRealtime(error);
      }
    });
  });

  let session: GeminiLiveWireSession | undefined;
  try {
    const connector = createOwnedGoogleGenAIConnector({
      apiKey: "phase-zero-loopback-only",
      httpOptions: {
        apiVersion: "v1beta",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    });
    session = await deadline(
      connector({
        model: "phase-zero-live-model",
        config: {
          responseModalities: [Modality.AUDIO],
          historyConfig: { initialHistoryInClientContent: true },
          sessionResumption: { handle: "wire-resume-handle" },
        },
        callbacks: { onmessage: (message) => serverEvents.push(message) },
      }),
      "SDK Live setup",
    );
    session.sendRealtimeInput({ text: "loopback transport proof" });
    await deadline(realtimeReceived, "SDK realtime input");
    await deadline(
      new Promise<void>((resolve) => {
        const poll = () => {
          if (
            serverEvents.some(
              (event) =>
                Boolean(event) &&
                typeof event === "object" &&
                "toolCall" in (event as Record<string, unknown>),
            )
          ) {
            resolve();
          } else setImmediate(poll);
        };
        poll();
      }),
      "SDK tool call",
    );
    session.sendToolResponse({
      functionResponses: {
        id: "wire-call-1",
        name: "computer_use",
        response: { output: { ok: true } },
      },
    });
    await deadline(toolResponseReceived, "SDK tool response");

    assert.match(
      requestUrl,
      /\/ws\/google\.ai\.generativelanguage\.v1beta\.GenerativeService\.BidiGenerateContent\?key=phase-zero-loopback-only$/u,
    );
    assert.deepEqual(messages, [
      {
        setup: {
          model: "models/phase-zero-live-model",
          generationConfig: { responseModalities: ["AUDIO"] },
          historyConfig: { initialHistoryInClientContent: true },
          sessionResumption: { handle: "wire-resume-handle" },
        },
      },
      { realtimeInput: { text: "loopback transport proof" } },
      {
        toolResponse: {
          functionResponses: [
            {
              id: "wire-call-1",
              name: "computer_use",
              response: { output: { ok: true } },
            },
          ],
        },
      },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(serverEvents)), [
      { setupComplete: {} },
      {
        toolCall: {
          functionCalls: [
            {
              id: "wire-call-1",
              name: "computer_use",
              args: { action: "capture" },
            },
          ],
        },
      },
    ]);
  } finally {
    session?.close();
    // Ensure a failed assertion cannot leave the loopback-only test socket alive.
    serverSocket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Local Live server shutdown",
    );
  }
});

test("Gemini 3.1 protocol terminates empty initial history on the real SDK wire", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Initial-history server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const messages: Array<Record<string, unknown>> = [];
  let serverSocket: LocalWebSocket | undefined;
  let resolveHistory!: () => void;
  const historyReceived = new Promise<void>((resolve) => {
    resolveHistory = resolve;
  });
  server.on("connection", (socket) => {
    serverSocket = socket;
    socket.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Record<string, unknown>;
      messages.push(message);
      if ("setup" in message)
        socket.send(JSON.stringify({ setupComplete: {} }));
      if ("clientContent" in message) resolveHistory();
    });
  });

  const protocol = new GeminiLiveProtocol({
    connector: createOwnedGoogleGenAIConnector({
      apiKey: "phase-zero-loopback-only",
      httpOptions: {
        apiVersion: "v1beta",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    }),
    model: "phase-zero-live-model",
    onEvent: () => undefined,
  });
  try {
    await deadline(protocol.start(), "Initial-history protocol start");
    await deadline(historyReceived, "Initial-history wire message");
    assert.equal("setup" in messages[0]!, true);
    assert.deepEqual(messages[1], {
      clientContent: { turnComplete: true },
    });
  } finally {
    protocol.stop();
    serverSocket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Initial-history server shutdown",
    );
  }
});

test("the owned SDK connector aborts and settles while setupComplete is withheld", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Withholding server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let socket: LocalWebSocket | undefined;
  let resolveSetup!: () => void;
  let resolveClosed!: () => void;
  const setupReceived = new Promise<void>(
    (resolve) => (resolveSetup = resolve),
  );
  const socketClosed = new Promise<void>(
    (resolve) => (resolveClosed = resolve),
  );
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Record<string, unknown>;
      if ("setup" in message) resolveSetup();
    });
    connected.on("close", resolveClosed);
  });

  try {
    const controller = new AbortController();
    const connector = createOwnedGoogleGenAIConnector({
      apiKey: "phase-zero-loopback-only",
      httpOptions: {
        apiVersion: "v1beta",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    });
    const connecting = connector({
      model: "phase-zero-live-model",
      config: {
        abortSignal: controller.signal,
        responseModalities: [Modality.AUDIO],
      },
      callbacks: { onmessage: () => undefined },
    });
    await deadline(setupReceived, "Withheld setup request");
    controller.abort();
    await assert.rejects(deadline(connecting, "Owned connector abort"), {
      name: "AbortError",
    });
    await deadline(socketClosed, "Owned connector socket close");
  } finally {
    socket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Withholding server shutdown",
    );
  }
});

test("protocol timeout terminates the owned SDK socket before setupComplete", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Timeout server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: LocalWebSocket | undefined;
  let resolveClosed!: () => void;
  const socketClosed = new Promise<void>(
    (resolve) => (resolveClosed = resolve),
  );
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("close", resolveClosed);
  });

  try {
    const connector = createOwnedGoogleGenAIConnector({
      apiKey: "phase-zero-loopback-only",
      httpOptions: {
        apiVersion: "v1beta",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    });
    const events: string[] = [];
    const protocol = new GeminiLiveProtocol({
      connector,
      connectTimeoutMs: 50,
      model: "phase-zero-live-model",
      onEvent: (event) => {
        if (event.type === "error") events.push(event.code);
      },
    });
    await assert.rejects(deadline(protocol.start(), "Protocol setup timeout"));
    assert.equal(protocol.state, "failed");
    assert.deepEqual(events, ["connect_timeout"]);
    await deadline(socketClosed, "Timed out SDK socket close");
  } finally {
    socket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Timeout server shutdown",
    );
  }
});

test("the owned connector rejects and settles an oversized loopback frame", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Oversized-frame server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: LocalWebSocket | undefined;
  let resolveClosed!: () => void;
  const socketClosed = new Promise<void>(
    (resolve) => (resolveClosed = resolve),
  );
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Record<string, unknown>;
      if ("setup" in message) {
        connected.send(
          "x".repeat(GEMINI_LIVE_MAX_RAW_WEBSOCKET_PAYLOAD_BYTES + 1),
        );
      }
    });
    connected.on("close", resolveClosed);
  });

  try {
    const connector = createOwnedGoogleGenAIConnector({
      apiKey: "phase-zero-loopback-only",
      httpOptions: {
        apiVersion: "v1beta",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    });
    await assert.rejects(
      deadline(
        connector({
          model: "phase-zero-live-model",
          config: { responseModalities: [Modality.AUDIO] },
          callbacks: { onmessage: () => undefined },
        }),
        "Oversized-frame connector rejection",
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /timed out/u);
        return true;
      },
    );
    await deadline(socketClosed, "Oversized-frame socket close");
  } finally {
    socket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Oversized-frame server shutdown",
    );
  }
});

test("the owned connector rejects malformed loopback text before the SDK parser", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Malformed-frame server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: LocalWebSocket | undefined;
  let resolveClosed!: () => void;
  const socketClosed = new Promise<void>(
    (resolve) => (resolveClosed = resolve),
  );
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Record<string, unknown>;
      if ("setup" in message) connected.send("{not-json");
    });
    connected.on("close", resolveClosed);
  });

  try {
    const connector = createOwnedGoogleGenAIConnector({
      apiKey: "phase-zero-loopback-only",
      httpOptions: {
        apiVersion: "v1beta",
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    });
    await assert.rejects(
      deadline(
        connector({
          model: "phase-zero-live-model",
          config: { responseModalities: [Modality.AUDIO] },
          callbacks: { onmessage: () => undefined },
        }),
        "Malformed-frame connector rejection",
      ),
      { name: "GeminiLiveConnectionError", code: "network" },
    );
    await deadline(socketClosed, "Malformed-frame socket close");
  } finally {
    socket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Malformed-frame server shutdown",
    );
  }
});

test("protocol start preserves the owned socket's fixed provider rejection category", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Provider-rejection server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: LocalWebSocket | undefined;
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Record<string, unknown>;
      if ("setup" in message) connected.close(1008, "API key not valid");
    });
  });

  try {
    const protocol = new GeminiLiveProtocol({
      connector: createOwnedGoogleGenAIConnector({
        apiKey: "phase-zero-loopback-only",
        httpOptions: {
          apiVersion: "v1beta",
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
      }),
      model: "phase-zero-live-model",
      onEvent: () => undefined,
    });
    await assert.rejects(
      deadline(protocol.start(), "Provider-rejection protocol start"),
      (error: unknown) => {
        assert.ok(error instanceof GeminiLiveConnectionError);
        assert.equal(error.code, "authentication");
        return true;
      },
    );
  } finally {
    socket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Provider-rejection server shutdown",
    );
  }
});

test("protocol start rejects a provider error envelope instead of timing out", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Error-envelope server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: LocalWebSocket | undefined;
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Record<string, unknown>;
      if ("setup" in message) {
        connected.send(
          JSON.stringify({
            error: {
              code: 429,
              message: "Resource exhausted for this project",
              status: "RESOURCE_EXHAUSTED",
            },
          }),
        );
      }
    });
  });

  try {
    const protocol = new GeminiLiveProtocol({
      connector: createOwnedGoogleGenAIConnector({
        apiKey: "phase-zero-loopback-only",
        httpOptions: {
          apiVersion: "v1beta",
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
      }),
      connectTimeoutMs: 1_000,
      model: "phase-zero-live-model",
      onEvent: () => undefined,
    });
    await assert.rejects(
      deadline(protocol.start(), "Error-envelope protocol start"),
      (error: unknown) => {
        assert.ok(error instanceof GeminiLiveConnectionError);
        assert.equal(error.code, "quota");
        return true;
      },
    );
  } finally {
    socket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Error-envelope server shutdown",
    );
  }
});

test("a deeply nested provider error fails closed without recursive serialization", async () => {
  const sdkRequire = createRequire(
    path.join(modulesRoot, "@google/genai/package.json"),
  );
  const { WebSocketServer } = sdkRequire("ws") as {
    WebSocketServer: LocalWebSocketServerConstructor;
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await deadline(
    new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    }),
    "Deep-error server startup",
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: LocalWebSocket | undefined;
  let resolveClosed!: () => void;
  const socketClosed = new Promise<void>(
    (resolve) => (resolveClosed = resolve),
  );
  const nestedError = `${"[".repeat(10_000)}0${"]".repeat(10_000)}`;
  server.on("connection", (connected) => {
    socket = connected;
    connected.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as Record<string, unknown>;
      if ("setup" in message) connected.send(`{"error":${nestedError}}`);
    });
    connected.on("close", resolveClosed);
  });

  try {
    const protocol = new GeminiLiveProtocol({
      connector: createOwnedGoogleGenAIConnector({
        apiKey: "phase-zero-loopback-only",
        httpOptions: {
          apiVersion: "v1beta",
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
      }),
      connectTimeoutMs: 1_000,
      model: "phase-zero-live-model",
      onEvent: () => undefined,
    });
    await assert.rejects(
      deadline(protocol.start(), "Deep-error protocol start"),
      (error: unknown) => {
        assert.ok(error instanceof GeminiLiveConnectionError);
        assert.equal(error.code, "network");
        return true;
      },
    );
    await deadline(socketClosed, "Deep-error socket close");
  } finally {
    socket?.terminate();
    await deadline(
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
      "Deep-error server shutdown",
    );
  }
});

test("the installed SDK declarations contain every Phase-0 Live transport surface", async () => {
  const declarations = await readFile(
    path.join(modulesRoot, "@google/genai/dist/node/node.d.ts"),
    "utf8",
  );
  for (const symbol of [
    "connect(params: types.LiveConnectParameters): Promise<Session>",
    "sendClientContent(params: types.LiveSendClientContentParameters): void",
    "sendRealtimeInput(params: types.LiveSendRealtimeInputParameters): void",
    "sendToolResponse(params: types.LiveSendToolResponseParameters): void",
    "close(): void",
    "audioStreamEnd?: boolean",
    "text?: string",
    "interrupted?: boolean",
    "inputTranscription?: Transcription",
    "outputTranscription?: Transcription",
    "functionCalls?: FunctionCall[]",
    "toolCallCancellation?: LiveServerToolCallCancellation",
    "goAway?: LiveServerGoAway",
    "sessionResumptionUpdate?: LiveServerSessionResumptionUpdate",
    "contextWindowCompression?: ContextWindowCompressionConfig",
    "abortSignal?: AbortSignal",
  ]) {
    assert.ok(
      declarations.includes(symbol),
      `missing reviewed SDK declaration: ${symbol}`,
    );
  }
});

test("Aiden's exact Pi Google adapter remains ordinary generateContent streaming only", async () => {
  const googleAdapter = await readFile(
    path.join(
      modulesRoot,
      "@earendil-works/pi-ai/dist/api/google-generative-ai.js",
    ),
    "utf8",
  );
  assert.match(
    googleAdapter,
    /client\.models\.generateContentStream\(params\)/u,
  );
  assert.doesNotMatch(
    googleAdapter,
    /live\.connect|bidiGenerateContent|sendRealtimeInput/u,
  );
});

test("Electron 43.1.1 declares the display handler, exact-frame request, and system picker", async () => {
  const electronRoot = path.join(modulesRoot, "electron");
  const manifest = JSON.parse(
    await readFile(path.join(electronRoot, "package.json"), "utf8"),
  ) as {
    version?: unknown;
  };
  const declarations = await readFile(
    path.join(electronRoot, "electron.d.ts"),
    "utf8",
  );
  assert.equal(manifest.version, "43.1.1");
  assert.match(declarations, /setDisplayMediaRequestHandler\(/u);
  assert.match(declarations, /frame: \(WebFrameMain\) \| \(null\)/u);
  assert.match(declarations, /userGesture: boolean/u);
  assert.match(declarations, /useSystemPicker: boolean/u);
  assert.match(
    declarations,
    /If the system picker[\s\S]{0,180}the handler will not be[\s\S]{0,30}invoked/u,
  );
  assert.match(
    declarations,
    /permission: 'clipboard-read'[^\n]+'display-capture'/u,
  );
});
