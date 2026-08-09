import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubagentAuthorityV2,
  type SubagentAuthorityV2,
} from "./authority-v2.js";
import {
  MAX_SUBAGENT_WEB_QUERY_BYTES,
  MAX_SUBAGENT_WEB_QUERY_CHARS,
  MAX_SUBAGENT_WEB_RESPONSE_BYTES,
  MAX_SUBAGENT_WEB_RESULT_BYTES,
  MAX_SUBAGENT_WEB_RESULTS,
  MAX_SUBAGENT_WEB_TEXT_BYTES,
  SUBAGENT_WEB_PROXY_TIMEOUT_MS,
  SubagentWebProxyHost,
  type ConsumeSubagentNetworkOperation,
  type SubagentWebProxyHostDependencies,
} from "./subagent-web-proxy.js";

const SECRET = "exa-secret-do-not-disclose";
const HASH = "a".repeat(64);

function authority(
  overrides: {
    runId?: string;
    grantId?: string;
    authorityRevision?: number;
    execution?: "foreground" | "background";
    web?: boolean;
    expiresAt?: number;
    maxNetworkOperations?: number;
  } = {},
): SubagentAuthorityV2 {
  return createSubagentAuthorityV2({
    grantId: overrides.grantId ?? "grant-web",
    treeRootId: "tree-web",
    runId: overrides.runId ?? "run-web",
    depth: 1,
    authorityRevision: overrides.authorityRevision ?? 1,
    generationId: "generation-web",
    chatId: "chat-web",
    workspaceId: "workspace-web",
    workspaceRevision: HASH,
    ownerDocumentId: "document-web",
    providerFingerprint: HASH,
    modelFingerprint: HASH,
    contextRevision: HASH,
    execution: overrides.execution ?? "foreground",
    context: "fresh",
    thinkingLevel: "medium",
    capabilities: {
      workspaceRead: false,
      workspaceWrite: false,
      shell: false,
      web: overrides.web ?? true,
      delegation: false,
      mcp: [],
    },
    budgets: {
      deadlineMs: 60_000,
      maxTurns: 24,
      maxToolCalls: 64,
      maxOutputChars: 120_000,
      maxTokens: 100_000,
      maxLaunches: 8,
      maxDepth: 2,
      maxActive: 2,
      maxQueued: 8,
      maxNetworkOperations: overrides.maxNetworkOperations ?? 4,
    },
    expiresAt: overrides.expiresAt ?? 60_000,
  });
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function harness(
  overrides: Partial<SubagentWebProxyHostDependencies> = {},
): {
  host: SubagentWebProxyHost;
  scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }>;
} {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const host = new SubagentWebProxyHost({
    fetch: async () => jsonResponse({ results: [] }),
    webSearchEnabled: async () => true,
    readExaApiKey: async () => SECRET,
    now: () => 1_000,
    scheduleTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...overrides,
  });
  return { host, scheduled };
}

function webTool(
  host: SubagentWebProxyHost,
  grant: unknown,
  consumeNetworkOperation: ConsumeSubagentNetworkOperation = () => true,
) {
  return host.toolForAuthority(grant, () => grant, consumeNetworkOperation);
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    assert.fail("expected operation to reject");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length <= 160);
    return error.message;
  }
}

test("web tools require exact live foreground V2 authority with a positive web grant", () => {
  const { host } = harness();
  assert.equal(webTool(host, { version: 1 }), null);
  assert.equal(webTool(host, { ...authority(), version: 1 }), null);
  assert.equal(webTool(host, authority({ web: false })), null);
  assert.equal(webTool(host, authority({ execution: "background" })), null);
  assert.equal(webTool(host, authority({ expiresAt: 999 })), null);
  assert.equal(webTool(host, { ...authority(), extra: true }), null);
  assert.equal(webTool(host, authority())?.name, "web_search");
});

test("the host owns credentials and fixes redirect, timeout, request, and signal policy", async () => {
  let request:
    | { input: string | URL | Request; init: RequestInit | undefined }
    | undefined;
  const { host, scheduled } = harness({
    fetch: async (input, init) => {
      request = { input, init };
      return jsonResponse({
        results: [{ title: "Result", url: "https://example.test", text: "Evidence" }],
      });
    },
  });
  const tool = webTool(host, authority());
  assert.ok(tool);
  assert.doesNotMatch(JSON.stringify(tool), new RegExp(SECRET, "u"));
  const caller = new AbortController();
  const result = await tool.execute(
    "call-1",
    { query: "bounded query", numResults: 3 },
    caller.signal,
  );
  assert.equal(String(request?.input), "https://api.exa.ai/search");
  assert.equal(request?.init?.redirect, "error");
  assert.equal(request?.init?.credentials, "omit");
  assert.equal(request?.init?.referrerPolicy, "no-referrer");
  assert.equal(request?.init?.cache, "no-store");
  assert.ok(request?.init?.signal instanceof AbortSignal);
  assert.equal(request?.init?.signal?.aborted, false);
  assert.equal((request?.init?.headers as Record<string, string>)["x-api-key"], SECRET);
  assert.equal(scheduled[0]?.delayMs, SUBAGENT_WEB_PROXY_TIMEOUT_MS);
  assert.equal(scheduled[0]?.cancelled, true);
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", new RegExp(SECRET, "u"));
});

test("abort before fetch consumes no network operation", async () => {
  let fetches = 0;
  let charges = 0;
  const { host } = harness({
    fetch: async () => {
      fetches += 1;
      return jsonResponse({ results: [] });
    },
  });
  const tool = webTool(host, authority({ maxNetworkOperations: 1 }), () => {
    charges += 1;
    return charges <= 1;
  });
  assert.ok(tool);
  const cancelled = new AbortController();
  cancelled.abort(new Error(`${SECRET} caller detail`));
  assert.equal(
    await rejectionMessage(tool.execute("cancelled", { query: "private query" }, cancelled.signal)),
    "Web search was cancelled.",
  );
  await tool.execute("allowed", { query: "public query" });
  assert.equal(fetches, 1);
  assert.equal(charges, 1);
});

test("an abort after fetch begins propagates and permanently consumes budget", async () => {
  let fetchSignal: AbortSignal | null | undefined;
  let started: (() => void) | undefined;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { host } = harness({
    fetch: async (_input, init) => {
      fetchSignal = init?.signal;
      started?.();
      return await new Promise<Response>(() => {});
    },
  });
  let remaining = 1;
  const tool = webTool(host, authority({ maxNetworkOperations: 1 }), () => {
    if (remaining <= 0) return false;
    remaining -= 1;
    return true;
  });
  assert.ok(tool);
  const caller = new AbortController();
  const operation = tool.execute("active", { query: "query" }, caller.signal);
  await didStart;
  caller.abort(new Error(`${SECRET} caller detail`));
  assert.equal(await rejectionMessage(operation), "Web search was cancelled.");
  assert.equal(fetchSignal?.aborted, true);
  assert.equal(
    await rejectionMessage(tool.execute("over-budget", { query: "query" })),
    "Web search network budget exhausted.",
  );
});

test("the fixed host timeout aborts fetch without exposing provider details", async () => {
  let fetchSignal: AbortSignal | null | undefined;
  let started: (() => void) | undefined;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { host, scheduled } = harness({
    fetch: async (_input, init) => {
      fetchSignal = init?.signal;
      started?.();
      return await new Promise<Response>(() => {});
    },
  });
  const tool = webTool(host, authority());
  assert.ok(tool);
  const operation = tool.execute("timeout", { query: `${SECRET} query` });
  await didStart;
  assert.equal(scheduled[0]?.delayMs, SUBAGENT_WEB_PROXY_TIMEOUT_MS);
  scheduled[0]?.callback();
  assert.equal(await rejectionMessage(operation), "Web search timed out.");
  assert.equal(fetchSignal?.aborted, true);
});

test("query character and UTF-8 byte ceilings fail before fetch and budget", async () => {
  let fetches = 0;
  let charges = 0;
  const { host } = harness({
    fetch: async () => {
      fetches += 1;
      return jsonResponse({ results: [] });
    },
  });
  const tool = webTool(host, authority({ maxNetworkOperations: 1 }), () => {
    charges += 1;
    return charges <= 1;
  });
  assert.ok(tool);
  assert.equal(
    await rejectionMessage(tool.execute("blank", { query: " \t\n " })),
    "Web search request exceeded its size limit.",
  );
  assert.equal(
    await rejectionMessage(
      tool.execute("chars", { query: "a".repeat(MAX_SUBAGENT_WEB_QUERY_CHARS + 1) }),
    ),
    "Web search request exceeded its size limit.",
  );
  const multibyte = "€".repeat(Math.floor(MAX_SUBAGENT_WEB_QUERY_BYTES / 3) + 1);
  assert.ok(multibyte.length <= MAX_SUBAGENT_WEB_QUERY_CHARS);
  assert.equal(
    await rejectionMessage(tool.execute("bytes", { query: multibyte })),
    "Web search request exceeded its size limit.",
  );
  await tool.execute("valid", { query: "still allowed" });
  assert.equal(fetches, 1);
  assert.equal(charges, 1);
});

test("content-length and streaming bytes independently cap provider responses", async () => {
  const declared = harness({
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(MAX_SUBAGENT_WEB_RESPONSE_BYTES + 1) },
      }),
  }).host;
  const declaredTool = webTool(declared, authority({ runId: "run-declared" }));
  assert.ok(declaredTool);
  assert.equal(
    await rejectionMessage(declaredTool.execute("declared", { query: "query" })),
    "Web search response exceeded its size limit.",
  );

  const streaming = harness({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_SUBAGENT_WEB_RESPONSE_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  }).host;
  const streamingTool = webTool(streaming, authority({ runId: "run-stream" }));
  assert.ok(streamingTool);
  assert.equal(
    await rejectionMessage(streamingTool.execute("stream", { query: "query" })),
    "Web search response exceeded its size limit.",
  );
});

test("result count and fields are byte-bounded, credential-redacted, and URL-userinfo-free", async () => {
  const results = Array.from({ length: MAX_SUBAGENT_WEB_RESULTS + 4 }, (_value, index) => ({
    title: `Title ${index} ${SECRET}`,
    url: `https://alice:${SECRET}@example.test/${index}?echo=${encodeURIComponent(SECRET)}`,
    text: `${SECRET}${"😀".repeat(MAX_SUBAGENT_WEB_TEXT_BYTES)}`,
  }));
  const { host } = harness({ fetch: async () => jsonResponse({ results }) });
  const tool = webTool(host, authority());
  assert.ok(tool);
  const output = await tool.execute("results", { query: "query", numResults: 10 });
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  assert.ok(new TextEncoder().encode(text).byteLength <= MAX_SUBAGENT_WEB_RESULT_BYTES);
  assert.doesNotMatch(text, new RegExp(SECRET, "u"));
  assert.doesNotMatch(text, /alice:/u);
  const payload = JSON.parse(text.slice(text.indexOf("\n") + 1)) as {
    results: Array<{ title: string; url: string; text: string }>;
  };
  assert.equal(payload.results.length, MAX_SUBAGENT_WEB_RESULTS);
  for (const result of payload.results) {
    assert.ok(new TextEncoder().encode(result.text).byteLength <= MAX_SUBAGENT_WEB_TEXT_BYTES);
  }
});

test("provider failures, HTTP bodies, malformed JSON, and disabled config yield bounded safe errors", async () => {
  const cases: Array<{
    name: string;
    dependencies: Partial<SubagentWebProxyHostDependencies>;
    expected?: string;
  }> = [
    {
      name: "fetch",
      dependencies: {
        fetch: async () => {
          throw new Error(`${SECRET} private query https://alice:password@example.test`);
        },
      },
    },
    {
      name: "http",
      dependencies: {
        fetch: async () =>
          new Response(`${SECRET} private query API diagnostic`, { status: 429 }),
      },
    },
    {
      name: "json",
      dependencies: { fetch: async () => new Response(`${SECRET} not JSON`) },
    },
    {
      name: "disabled",
      dependencies: { webSearchEnabled: async () => false },
      expected: "Web search is not available for this child.",
    },
  ];
  for (const entry of cases) {
    const { host } = harness(entry.dependencies);
    const tool = webTool(host, authority({ runId: `run-${entry.name}` }));
    assert.ok(tool);
    const message = await rejectionMessage(
      tool.execute(`call-${entry.name}`, { query: "private query" }),
    );
    assert.equal(message, entry.expected ?? "Web search is temporarily unavailable.");
    assert.doesNotMatch(message, new RegExp(SECRET, "u"));
    assert.doesNotMatch(message, /private query|alice|password|429|diagnostic/iu);
  }
});

test("network reservation is atomic across concurrent tools for one authority", async () => {
  let fetches = 0;
  let release: ((response: Response) => void) | undefined;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const { host } = harness({
    fetch: async () => {
      fetches += 1;
      return await held;
    },
  });
  const grant = authority({ maxNetworkOperations: 1 });
  let remaining = grant.budgets.maxNetworkOperations;
  const sharedConsumer: ConsumeSubagentNetworkOperation = () => {
    if (remaining <= 0) return false;
    remaining -= 1;
    return true;
  };
  const first = webTool(host, grant, sharedConsumer);
  const second = webTool(host, grant, sharedConsumer);
  assert.ok(first);
  assert.ok(second);
  const running = first.execute("first", { query: "one" });
  while (fetches === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await rejectionMessage(second.execute("second", { query: "two" })),
    "Web search network budget exhausted.",
  );
  assert.equal(fetches, 1);
  release?.(jsonResponse({ results: [] }));
  await running;
});

test("authority expiry is rechecked after tool construction and after provider I/O", async () => {
  let now = 1_000;
  const { host } = harness({
    now: () => now,
    fetch: async () => {
      now = 60_000;
      return jsonResponse({ results: [] });
    },
  });
  const grant = authority({ expiresAt: 50_000 });
  const tool = webTool(host, grant);
  assert.ok(tool);
  assert.equal(
    await rejectionMessage(tool.execute("expired-after", { query: "query" })),
    "Web search is not available for this child.",
  );
  assert.equal(webTool(host, authority({ expiresAt: 50_000 })), null);
});

test("current authority and config are revalidated immediately around provider I/O", async () => {
  const grant = authority({ runId: "run-drift", maxNetworkOperations: 2 });
  let current: unknown = grant;
  const authorityHost = harness({
    fetch: async () => {
      current = authority({ runId: "run-drift", web: false, maxNetworkOperations: 2 });
      return jsonResponse({ results: [] });
    },
  }).host;
  const authorityTool = authorityHost.toolForAuthority(grant, () => current, () => true);
  assert.ok(authorityTool);
  assert.equal(
    await rejectionMessage(authorityTool.execute("authority-drift", { query: "query" })),
    "Web search is not available for this child.",
  );

  let enabled = true;
  const configHost = harness({
    webSearchEnabled: async () => enabled,
    fetch: async () => {
      enabled = false;
      return jsonResponse({ results: [] });
    },
  }).host;
  const configGrant = authority({ runId: "run-config" });
  const configTool = configHost.toolForAuthority(configGrant, () => configGrant, () => true);
  assert.ok(configTool);
  assert.equal(
    await rejectionMessage(configTool.execute("config-drift", { query: "query" })),
    "Web search is not available for this child.",
  );
});

test("a web call cannot spend a ceiling already consumed by MCP", async () => {
  const { host } = harness();
  const grant = authority({ runId: "run-shared-budget", maxNetworkOperations: 1 });
  let remaining = grant.budgets.maxNetworkOperations;
  const consumeSharedNetworkOperation: ConsumeSubagentNetworkOperation = () => {
    if (remaining <= 0) return false;
    remaining -= 1;
    return true;
  };
  // The MCP host and web host receive this same main-owned consumer. Simulate
  // the exact MCP call-site charge before the child attempts web_search.
  assert.equal(await consumeSharedNetworkOperation(grant), true);
  const tool = host.toolForAuthority(
    grant,
    () => grant,
    consumeSharedNetworkOperation,
  );
  assert.ok(tool);
  assert.equal(
    await rejectionMessage(tool.execute("web-after-mcp", { query: "query" })),
    "Web search network budget exhausted.",
  );
});

test("web snapshots approved primitives before asynchronous host checks", async () => {
  let releaseEnabled!: () => void;
  let enabledReads = 0;
  let requestBody: unknown;
  const { host } = harness({
    webSearchEnabled: async () => {
      enabledReads += 1;
      if (enabledReads === 1) {
        await new Promise<void>((resolve) => {
          releaseEnabled = resolve;
        });
      }
      return true;
    },
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({ results: [] });
    },
  });
  const grant = authority({ runId: "run-immutable-web" });
  const tool = webTool(host, grant);
  assert.ok(tool);
  const args = { query: "approved query", numResults: 2 };
  const running = tool.execute("immutable-web", args);
  args.query = "mutated after approval";
  args.numResults = 9;
  releaseEnabled();
  await running;
  assert.deepEqual(requestBody, {
    query: "approved query",
    numResults: 2,
    contents: { text: { maxCharacters: MAX_SUBAGENT_WEB_TEXT_BYTES } },
  });
});

test("web rejects credential rotation or expiry during final key resolution before effect", async () => {
  for (const mode of ["rotate", "expire"] as const) {
    let keyReads = 0;
    let now = 1_000;
    let fetches = 0;
    let budgetCharges = 0;
    const { host } = harness({
      now: () => now,
      readExaApiKey: async () => {
        keyReads += 1;
        if (keyReads === 2) {
          if (mode === "expire") now = 1_500;
          if (mode === "rotate") return `${SECRET}-rotated`;
        }
        return SECRET;
      },
      fetch: async () => {
        fetches += 1;
        return jsonResponse({ results: [] });
      },
    });
    const grant = authority({ runId: `run-${mode}-web`, expiresAt: 1_500 });
    const tool = host.toolForAuthority(grant, () => grant, () => {
      budgetCharges += 1;
      return true;
    });
    assert.ok(tool);
    assert.equal(
      await rejectionMessage(tool.execute(`${mode}-web`, { query: "query" })),
      "Web search is not available for this child.",
    );
    assert.equal(fetches, 0);
    assert.equal(budgetCharges, 0);
  }
});
