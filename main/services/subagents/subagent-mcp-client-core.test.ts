import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer } from "../types.js";
import {
  MAX_SUBAGENT_MCP_CLIENT_REDACTORS,
  SUBAGENT_MCP_REQUEST_TIMEOUT_MS,
  withIsolatedSubagentMcpClientCore,
  type IsolatedSubagentMcpClientDependencies,
  type IsolatedSubagentMcpSdkClient,
} from "./subagent-mcp-client-core.js";

const server: McpServer = {
  id: "server-one",
  name: "Server One",
  transport: "http",
  url: "https://mcp.example.test",
  headers: { authorization: "private" },
  enabled: true,
};

interface Harness {
  dependencies: IsolatedSubagentMcpClientDependencies;
  configurationLease: { signal: AbortSignal; assertCurrent(): void };
  events: string[];
  requestSignals: AbortSignal[];
  transportPolicy: Array<{ forceNoRedirect: true }>;
}

function harness(): Harness {
  const events: string[] = [];
  const requestSignals: AbortSignal[] = [];
  const transportPolicy: Array<{ forceNoRedirect: true }> = [];
  const client: IsolatedSubagentMcpSdkClient = {
    connect: async (_transport, options) => {
      events.push("connect");
      requestSignals.push(options.signal);
      assert.equal(options.timeout, SUBAGENT_MCP_REQUEST_TIMEOUT_MS);
      assert.equal(options.maxTotalTimeout, SUBAGENT_MCP_REQUEST_TIMEOUT_MS);
    },
    close: async () => {
      events.push("close");
    },
    listTools: async (_params, options) => {
      events.push("list");
      requestSignals.push(options.signal);
      assert.equal(options.timeout, SUBAGENT_MCP_REQUEST_TIMEOUT_MS);
      return {
        tools: [
          {
            name: "lookup",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    },
    callTool: async (_params, _schema, options) => {
      events.push("call");
      requestSignals.push(options.signal);
      assert.equal(options.maxTotalTimeout, SUBAGENT_MCP_REQUEST_TIMEOUT_MS);
      return { content: [{ type: "text", text: "evidence echo-secret" }] };
    },
  };
  return {
    events,
    requestSignals,
    transportPolicy,
    configurationLease: {
      signal: new AbortController().signal,
      assertCurrent: () => events.push("config-fence"),
    },
    dependencies: {
      createClient: () => {
        events.push("create");
        return client;
      },
      resolveAuth: async (configured, isCurrent) => {
        events.push("auth");
        assert.equal(isCurrent(), true);
        return configured;
      },
      resolveCredentialBoundary: async () => {
        events.push("credential");
        return {
          revision: "c".repeat(64),
          redactText: (text) => text.split("echo-secret").join("[REDACTED]"),
        };
      },
      makeTransport: (_configured, isCurrent, options) => {
        events.push("transport");
        assert.equal(isCurrent(), true);
        transportPolicy.push({ forceNoRedirect: options.forceNoRedirect });
        return { kind: "fake-transport" };
      },
      withConfigured: async (configured, operation, isCurrent) => {
        events.push("admit");
        assert.equal(configured.id, server.id);
        assert.equal(isCurrent(), true);
        return operation();
      },
    },
  };
}

test("isolated production core forces no-redirect and closes after bounded SDK requests", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const result = await withIsolatedSubagentMcpClientCore({
    server,
    signal,
    configurationLease: h.configurationLease,
    dependencies: h.dependencies,
    operation: async (client) => {
      const tools = await client.listTools(signal);
      assert.equal(tools[0]?.name, "lookup");
      return client.callTool("lookup", { query: "safe" }, signal, () => {
        h.events.push("effect");
      });
    },
  });
  assert.deepEqual(result, {
    content: [{ type: "text", text: "evidence [REDACTED]" }],
  });
  assert.deepEqual(h.transportPolicy, [{ forceNoRedirect: true }]);
  assert.deepEqual(h.events, [
    "config-fence",
    "admit",
    "create",
    "credential",
    "auth",
    "transport",
    "config-fence",
    "connect",
    "credential",
    "config-fence",
    "list",
    "credential",
    "credential",
    "effect",
    "config-fence",
    "call",
    "credential",
    "close",
  ]);
  assert.ok(h.requestSignals.every((requestSignal) => requestSignal === signal));
});

test("mutation raw boundary fences and invokes the SDK exactly once without an await gap", async () => {
  const h = harness();
  const signal = new AbortController().signal;
  let rawCalls = 0;
  h.dependencies.createClient = () => ({
    connect: async () => undefined,
    close: async () => {
      h.events.push("close");
    },
    listTools: async () => ({ tools: [] }),
    callTool: (_params, _schema, options) => {
      rawCalls += 1;
      h.events.push("raw-sdk-call");
      assert.equal(options.signal, signal);
      return Promise.resolve({
        isError: false,
        content: [{ type: "text", text: "done echo-secret" }],
      });
    },
  });
  const response = await withIsolatedSubagentMcpClientCore({
    server,
    signal,
    configurationLease: h.configurationLease,
    dependencies: h.dependencies,
    operation: async (client) => {
      assert.ok(client.callToolRaw);
      return client.callToolRaw("publish", { value: 1 }, signal, () => {
        h.events.push("final-authority-ledger-budget-fence");
      });
    },
  });
  assert.equal(rawCalls, 1);
  assert.deepEqual(response, {
    isError: false,
    content: [{ type: "text", text: "done [REDACTED]" }],
  });
  assert.ok(
    h.events.indexOf("config-fence") < h.events.indexOf("final-authority-ledger-budget-fence"),
  );
  assert.equal(
    h.events.indexOf("raw-sdk-call"),
    h.events.indexOf("final-authority-ledger-budget-fence") + 1,
  );
});

test("configuration invalidation during awaited auth prevents raw connect", async () => {
  const h = harness();
  let current = true;
  let connected = false;
  h.configurationLease = {
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (!current) throw new Error("MCP server configuration changed.");
    },
  };
  h.dependencies.resolveAuth = async (configured) => {
    current = false;
    return configured;
  };
  h.dependencies.createClient = () => ({
    connect: async () => {
      connected = true;
    },
    close: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
  });
  await assert.rejects(
    withIsolatedSubagentMcpClientCore({
      server,
      signal: new AbortController().signal,
      configurationLease: h.configurationLease,
      dependencies: h.dependencies,
      operation: async () => undefined,
    }),
    /configuration changed/u,
  );
  assert.equal(connected, false);
});

test("configuration drift at the list boundary prevents raw inventory request", async () => {
  const h = harness();
  let current = true;
  let listed = false;
  h.configurationLease = {
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (!current) throw new Error("MCP server configuration changed.");
    },
  };
  h.dependencies.createClient = () => ({
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => {
      listed = true;
      return { tools: [] };
    },
    callTool: async () => ({ content: [] }),
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    withIsolatedSubagentMcpClientCore({
      server,
      signal,
      configurationLease: h.configurationLease,
      dependencies: h.dependencies,
      operation: (client) => {
        current = false;
        return client.listTools(signal);
      },
    }),
    /configuration changed/u,
  );
  assert.equal(listed, false);
});

test("configuration drift at the immediate raw-call fence prevents dispatch", async () => {
  const h = harness();
  let current = true;
  let rawCallStarted = false;
  h.configurationLease = {
    signal: new AbortController().signal,
    assertCurrent: () => {
      h.events.push("config-fence");
      if (!current) throw new Error("MCP server configuration changed.");
    },
  };
  h.dependencies.createClient = () => ({
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      rawCallStarted = true;
      return { content: [] };
    },
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    withIsolatedSubagentMcpClientCore({
      server,
      signal,
      configurationLease: h.configurationLease,
      dependencies: h.dependencies,
      operation: (client) =>
        client.callTool("lookup", {}, signal, () => {
          current = false;
        }),
    }),
    /configuration changed/u,
  );
  assert.equal(rawCallStarted, false);
});

test("abort reaches in-flight requests and triggers eager plus final client close", async () => {
  const h = harness();
  let requestSignal: AbortSignal | undefined;
  h.dependencies.createClient = () => ({
    connect: async () => undefined,
    close: async () => {
      h.events.push("close");
    },
    listTools: async () => ({ tools: [] }),
    callTool: async (_params, _schema, options) => {
      requestSignal = options.signal;
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      });
    },
  });
  const controller = new AbortController();
  const reason = new Error("stop exact child");
  const running = withIsolatedSubagentMcpClientCore({
    server,
    signal: controller.signal,
    configurationLease: h.configurationLease,
    dependencies: h.dependencies,
    operation: (client) => client.callTool("lookup", {}, controller.signal),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(running, (error: unknown) => error === reason);
  assert.equal(requestSignal?.aborted, true);
  assert.ok(h.events.filter((event) => event === "close").length >= 1);
});

test("credential rotation during connection closes before inventory or invocation", async () => {
  const h = harness();
  let reads = 0;
  h.dependencies.resolveCredentialBoundary = async () => ({
    revision: (reads++ === 0 ? "c" : "d").repeat(64),
    redactText: (text) => text,
  });
  let operated = false;
  await assert.rejects(
    withIsolatedSubagentMcpClientCore({
      server,
      signal: new AbortController().signal,
      configurationLease: h.configurationLease,
      dependencies: h.dependencies,
      operation: async () => {
        operated = true;
      },
    }),
    /credential revision changed/u,
  );
  assert.equal(operated, false);
  assert.equal(h.events[h.events.length - 1], "close");
});

test("same-revision OAuth refresh updates metadata and result redaction", async () => {
  const h = harness();
  let currentToken = "oauth-token-old";
  h.dependencies.resolveCredentialBoundary = async () => {
    const captured = currentToken;
    return {
      revision: "c".repeat(64),
      redactText: (text) => text.split(captured).join("[REDACTED]"),
    };
  };
  h.dependencies.createClient = () => ({
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => {
      currentToken = "oauth-token-fresh";
      return {
        tools: [
          {
            name: "lookup",
            inputSchema: {
              type: "object",
              description: currentToken,
            },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    },
    callTool: async () => {
      currentToken = "oauth-token-result";
      return { content: [{ type: "text", text: currentToken }] };
    },
  });
  const signal = new AbortController().signal;
  const result = await withIsolatedSubagentMcpClientCore({
    server,
    signal,
    configurationLease: h.configurationLease,
    dependencies: h.dependencies,
    operation: async (client) => {
      const tools = await client.listTools(signal);
      assert.equal(
        client.redactCredentialText(JSON.stringify(tools)).includes("oauth-token-fresh"),
        false,
      );
      return client.callTool("lookup", {}, signal);
    },
  });
  assert.equal(JSON.stringify(result).includes("oauth-token-result"), false);
});

test("transport-observed intermediate OAuth tokens survive double refresh for redaction", async () => {
  const h = harness();
  let currentToken = "oauth-token-initial";
  let registerTransportRedactor: ((redactor: (text: string) => string) => void) | undefined;
  h.dependencies.resolveCredentialBoundary = async () => {
    const captured = currentToken;
    return {
      revision: "c".repeat(64),
      redactText: (text) => text.split(captured).join("[REDACTED]"),
    };
  };
  h.dependencies.makeTransport = (_configured, _isCurrent, options) => {
    registerTransportRedactor = options.registerCredentialRedactor;
    return { kind: "fake-oauth-transport" };
  };
  h.dependencies.createClient = () => ({
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => {
      const intermediate = "oauth-intermediate-token";
      currentToken = intermediate;
      registerTransportRedactor?.((text) => text.split(intermediate).join("[REDACTED]"));
      currentToken = "oauth-token-after-intermediate";
      return { content: [{ type: "text", text: intermediate }] };
    },
  });
  const signal = new AbortController().signal;
  const result = await withIsolatedSubagentMcpClientCore({
    server,
    signal,
    configurationLease: h.configurationLease,
    dependencies: h.dependencies,
    operation: (client) => client.callTool("lookup", {}, signal),
  });
  assert.equal(JSON.stringify(result).includes("oauth-intermediate-token"), false);
});

test("transport redactor overflow fails closed before connection or remote effect", async () => {
  const h = harness();
  let connected = false;
  h.dependencies.makeTransport = (_configured, _isCurrent, options) => {
    for (let index = 0; index < MAX_SUBAGENT_MCP_CLIENT_REDACTORS; index += 1) {
      options.registerCredentialRedactor((text) => text);
    }
    return { kind: "unreachable" };
  };
  h.dependencies.createClient = () => ({
    connect: async () => {
      connected = true;
    },
    close: async () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
  });
  await assert.rejects(
    withIsolatedSubagentMcpClientCore({
      server,
      signal: new AbortController().signal,
      configurationLease: h.configurationLease,
      dependencies: h.dependencies,
      operation: async () => undefined,
    }),
    /redaction limit/u,
  );
  assert.equal(connected, false);
});

test("pre-aborted operations allocate no SDK client or transport", async () => {
  const h = harness();
  const controller = new AbortController();
  const reason = new Error("already stopped");
  controller.abort(reason);
  await assert.rejects(
    withIsolatedSubagentMcpClientCore({
      server,
      signal: controller.signal,
      configurationLease: h.configurationLease,
      dependencies: h.dependencies,
      operation: async () => undefined,
    }),
    (error: unknown) => error === reason,
  );
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.transportPolicy, []);
});

test("stdio is withheld before client, credential, or process-transport allocation", async () => {
  const h = harness();
  await assert.rejects(
    withIsolatedSubagentMcpClientCore({
      server: {
        ...server,
        transport: "stdio",
        url: undefined,
        command: "must-not-spawn",
      },
      signal: new AbortController().signal,
      configurationLease: h.configurationLease,
      dependencies: h.dependencies,
      operation: async () => undefined,
    }),
    /isolated remote transport/u,
  );
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.transportPolicy, []);
});
