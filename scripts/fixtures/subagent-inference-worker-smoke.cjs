/* global AbortController, clearTimeout, process, setTimeout */

const { createServer } = require("node:http");
const { app, utilityProcess } = require("electron");

const entry = process.env.AIDEN_SUBAGENT_WORKER_SMOKE_ENTRY;
const requestId = "subagent-worker-smoke";
const timeoutMs = 8_000;

if (!entry) throw new Error("AIDEN_SUBAGENT_WORKER_SMOKE_ENTRY is required.");

app.whenReady().then(async () => {
  app.dock?.hide();
  let ready = false;
  let requestObserved = false;
  let requestBeforeReady = false;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let requestBytes = 0;
    for await (const chunk of request) {
      requestBytes += chunk.length;
      if (requestBytes > 1024 * 1024) throw new Error("Smoke request exceeded 1 MiB.");
    }
    requestObserved = true;
    requestBeforeReady ||= !ready;
    const common = {
      id: "chatcmpl-subagent-worker-smoke",
      object: "chat.completion.chunk",
      created: 0,
      model: "smoke",
    };
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/event-stream",
    });
    response.write(
      `data: ${JSON.stringify({
        ...common,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "worker smoke complete" },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        ...common,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Smoke server did not bind TCP.");
  const child = utilityProcess.fork(entry, ["--aiden-inference-owner=smoke"], {
    serviceName: "Aiden Subagent Inference Smoke",
    stdio: "pipe",
    env: {
      NODE_ENV: "test",
      LANG: process.env.LANG || "en_US.UTF-8",
      TZ: process.env.TZ || "UTC",
    },
  });
  let completed = false;
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  child.on("spawn", () => {
    const richContext = {
      systemPrompt: "smoke",
      messages: [],
      tools: [
        {
          name: "smoke_tool",
          description: "A clone-boundary smoke tool",
          parameters: { type: "object", properties: {} },
          label: "Smoke tool",
          execute: async () => ({ content: [], details: null }),
        },
      ],
    };
    const richOptions = {
      apiKey: "smoke",
      signal: new AbortController().signal,
      getApiKey: () => "must-stay-in-main",
    };
    const context = {
      systemPrompt: richContext.systemPrompt,
      messages: richContext.messages,
      tools: richContext.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    };
    const options = { apiKey: richOptions.apiKey };
    const wireRequest = JSON.parse(JSON.stringify({
      kind: "start",
      version: 1,
      requestId,
      model: {
        id: "smoke",
        name: "Smoke",
        api: "openai-completions",
        provider: "smoke",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        input: ["text"],
        reasoning: false,
        contextWindow: 4096,
        maxTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      context,
      options,
    }));
    child.postMessage(wireRequest);
  });
  child.on("message", (message) => {
    if (message?.requestId !== requestId) return;
    if (message.kind === "ready") {
      if (message.launchToken !== "smoke") {
        process.stderr.write("Worker readiness identity did not match its UtilityProcess argv.\n");
        child.kill();
        return;
      }
      ready = true;
      process.stdout.write("AIDEN_SUBAGENT_WORKER_READY\n");
      child.postMessage({ kind: "ready-ack", version: 1, requestId });
      return;
    }
    if (message.kind === "hook") {
      child.postMessage({
        kind: "hook-result",
        version: 1,
        requestId,
        callId: message.callId,
        ...(message.hook === "payload" ? { payload: message.payload } : {}),
      });
      return;
    }
    if (message.kind === "event" && message.event?.type === "done") {
      completed = true;
      process.stdout.write("AIDEN_SUBAGENT_WORKER_COMPLETED\n");
      child.postMessage({ kind: "terminal-ack", version: 1, requestId });
      return;
    }
    if (message.kind === "event" && message.event?.type === "error") {
      process.stderr.write("Worker returned a provider error.\n");
      child.postMessage({ kind: "terminal-ack", version: 1, requestId });
    }
  });
  child.on("error", (type, location) => {
    process.stderr.write(`UtilityProcess ${type} at ${location}\n`);
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    const passed = ready && completed && requestObserved && !requestBeforeReady && code === 0;
    if (!passed) {
      process.stderr.write(
        `${requestBeforeReady ? "Provider dispatch preceded readiness. " : ""}Worker exited before completion (${code}).\n${stderr}`,
      );
    }
    server.close(() => app.exit(passed ? 0 : 1));
    server.closeAllConnections();
  });
  const timeout = setTimeout(() => {
    process.stderr.write(`Worker readiness timed out.\n${stderr}`);
    child.kill();
    app.exit(1);
  }, timeoutMs);
});
