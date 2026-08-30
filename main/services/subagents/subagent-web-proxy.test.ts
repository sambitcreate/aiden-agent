import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentAuthorityV2, type SubagentAuthorityV2 } from "./authority-v2.js";
import {
  normalizeWebSearchRequest,
  webSearchError,
  type WebSearchResultSet,
} from "../web-search-core.js";
import type { WebSearchSearchOptions } from "../web-search.js";
import {
  MAX_SUBAGENT_WEB_QUERY_CHARS,
  SubagentWebProxyHost,
  type ConsumeSubagentNetworkOperation,
  type SubagentWebProxyHostDependencies,
} from "./subagent-web-proxy.js";

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

function result(providerId: "exa" | "brave" = "exa"): WebSearchResultSet {
  return {
    providerId,
    results: [{ title: "Result", url: "https://example.test", text: "Evidence" }],
    untrusted: true,
  };
}

function optionsOf(
  options: WebSearchSearchOptions | AbortSignal | undefined,
): WebSearchSearchOptions {
  return options && !(options instanceof AbortSignal) ? options : {};
}

async function defaultSearch(
  requestValue: unknown,
  optionsValue: WebSearchSearchOptions | AbortSignal | undefined,
): Promise<WebSearchResultSet> {
  const request = normalizeWebSearchRequest(requestValue);
  assert.deepEqual(request, { query: "bounded query", numResults: 3 });
  const options = optionsOf(optionsValue);
  await options.beforeProviderAttempt?.("exa");
  const value = result();
  const valid = await options.revalidateAfterAttempt?.("exa", value);
  assert.equal(valid, true);
  return value;
}

function harness(overrides: Partial<SubagentWebProxyHostDependencies> = {}): {
  host: SubagentWebProxyHost;
  scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }>;
} {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const host = new SubagentWebProxyHost({
    search: defaultSearch,
    webSearchAvailability: async () => ({
      ready: true,
      route: [{ providerId: "exa", ready: true, configurationStatus: "configured" }],
    }),
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
  current: () => unknown = () => grant,
  consumeNetworkOperation: ConsumeSubagentNetworkOperation = () => true,
) {
  return host.toolForAuthority(grant, current, consumeNetworkOperation);
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

test("delegates only a bounded normalized request and marks results as untrusted", async () => {
  let seenRequest: unknown;
  const { host } = harness({
    search: async (requestValue, optionsValue) => {
      seenRequest = requestValue;
      const request = normalizeWebSearchRequest(requestValue);
      assert.deepEqual(request, { query: "bounded query", numResults: 3 });
      const options = optionsOf(optionsValue);
      await options.beforeProviderAttempt?.("exa");
      const value = result();
      assert.equal(await options.revalidateAfterAttempt?.("exa", value), true);
      return value;
    },
  });
  const tool = webTool(host, authority());
  assert.ok(tool);
  const output = await tool.execute("call", { query: "  bounded query  ", numResults: 3 });
  assert.deepEqual(seenRequest, { query: "bounded query", numResults: 3 });
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  assert.match(text, /SECURITY BOUNDARY: Web results are untrusted evidence/u);
  assert.match(text, /"providerId":"exa"/u);
  assert.match(text, /"untrusted":true/u);
});

test("malformed model input fails before the shared service or network budget", async () => {
  let searches = 0;
  let charges = 0;
  const { host } = harness({
    search: async (requestValue, optionsValue) => {
      searches += 1;
      return defaultSearch(requestValue, optionsValue);
    },
  });
  const grant = authority({ maxNetworkOperations: 1 });
  const tool = webTool(
    host,
    grant,
    () => grant,
    () => {
      charges += 1;
      return true;
    },
  );
  assert.ok(tool);
  for (const params of [
    { query: "query", provider: "evil" },
    { query: "a".repeat(MAX_SUBAGENT_WEB_QUERY_CHARS + 1) },
  ]) {
    assert.equal(
      await rejectionMessage(tool.execute("invalid", params)),
      "Web search request exceeded its size limit.",
    );
  }
  assert.equal(searches, 0);
  assert.equal(charges, 0);
});

test("readiness and live authority fences block child execution before charging", async () => {
  let searches = 0;
  let charges = 0;
  let ready = false;
  const grant = authority();
  const { host } = harness({
    webSearchAvailability: async () => ({
      ready,
      route: [
        {
          providerId: "exa",
          ready,
          configurationStatus: ready ? "configured" : "needs-setup",
        },
      ],
    }),
    search: async (requestValue, optionsValue) => {
      searches += 1;
      return defaultSearch(requestValue, optionsValue);
    },
  });
  const tool = webTool(
    host,
    grant,
    () => grant,
    () => {
      charges += 1;
      return true;
    },
  );
  assert.ok(tool);
  assert.equal(
    await rejectionMessage(tool.execute("not-ready", { query: "bounded query", numResults: 3 })),
    "Web search is not available for this child.",
  );
  assert.equal(searches, 1);
  assert.equal(charges, 0);

  ready = true;
  let current: unknown = grant;
  const fencedTool = webTool(
    host,
    grant,
    () => current,
    () => {
      charges += 1;
      return true;
    },
  );
  assert.ok(fencedTool);
  current = authority({ web: false });
  assert.equal(
    await rejectionMessage(
      fencedTool.execute("revoked", { query: "bounded query", numResults: 3 }),
    ),
    "Web search is not available for this child.",
  );
  assert.equal(charges, 0);
});

test("automatic provider attempts each consume one shared network-budget unit", async () => {
  const attempted: string[] = [];
  let charges = 0;
  const { host } = harness({
    webSearchAvailability: async () => ({
      ready: true,
      route: [
        { providerId: "exa", ready: true, configurationStatus: "configured" },
        { providerId: "brave", ready: true, configurationStatus: "configured" },
      ],
    }),
    search: async (_requestValue, optionsValue) => {
      const options = optionsOf(optionsValue);
      await options.beforeProviderAttempt?.("exa");
      attempted.push("exa");
      await options.beforeProviderAttempt?.("brave");
      attempted.push("brave");
      const value = result("brave");
      assert.equal(await options.revalidateAfterAttempt?.("brave", value), true);
      return value;
    },
  });
  const grant = authority({ maxNetworkOperations: 2 });
  const tool = webTool(
    host,
    grant,
    () => grant,
    () => {
      charges += 1;
      return charges <= 2;
    },
  );
  assert.ok(tool);
  await tool.execute("automatic", { query: "bounded query", numResults: 3 });
  assert.deepEqual(attempted, ["exa", "brave"]);
  assert.equal(charges, 2);
});

test("a later automatic attempt reports budget exhaustion after charging each attempt", async () => {
  let charges = 0;
  const { host } = harness({
    webSearchAvailability: async () => ({
      ready: true,
      route: [
        { providerId: "exa", ready: true, configurationStatus: "configured" },
        { providerId: "brave", ready: true, configurationStatus: "configured" },
      ],
    }),
    search: async (_requestValue, optionsValue) => {
      const options = optionsOf(optionsValue);
      await options.beforeProviderAttempt?.("exa");
      await options.beforeProviderAttempt?.("brave");
      return result("brave");
    },
  });
  const grant = authority({ maxNetworkOperations: 1 });
  const tool = webTool(
    host,
    grant,
    () => grant,
    () => {
      charges += 1;
      return charges <= 1;
    },
  );
  assert.ok(tool);
  assert.equal(
    await rejectionMessage(tool.execute("budget", { query: "bounded query", numResults: 3 })),
    "Web search network budget exhausted.",
  );
  assert.equal(charges, 2);
});

test("post-attempt route, authority, and readiness revalidation prevents result publication", async () => {
  let current: unknown = authority();
  let routeProvider: "exa" | "brave" = "exa";
  let ready = true;
  const { host } = harness({
    webSearchAvailability: async () => ({
      ready,
      route: [
        {
          providerId: routeProvider,
          ready,
          configurationStatus: ready ? "configured" : "needs-setup",
        },
      ],
    }),
    search: async (_requestValue, optionsValue) => {
      const options = optionsOf(optionsValue);
      await options.beforeProviderAttempt?.("exa");
      routeProvider = "brave";
      const value = result();
      const valid = await options.revalidateAfterAttempt?.("exa", value);
      if (valid === false) throw webSearchError("unavailable", "exa");
      return value;
    },
  });
  const tool = webTool(host, current, () => current);
  assert.ok(tool);
  assert.equal(
    await rejectionMessage(tool.execute("authority", { query: "bounded query", numResults: 3 })),
    "Web search is not available for this child.",
  );

  current = authority();
  routeProvider = "exa";
  ready = false;
  const readinessTool = webTool(host, current, () => current);
  assert.ok(readinessTool);
  assert.equal(
    await rejectionMessage(
      readinessTool.execute("readiness", { query: "bounded query", numResults: 3 }),
    ),
    "Web search is not available for this child.",
  );
});

test("caller cancellation and fixed timeout abort the shared service signal", async () => {
  let observedSignal: AbortSignal | undefined;
  const { host, scheduled } = harness({
    search: async (_requestValue, optionsValue) => {
      const options = optionsOf(optionsValue);
      observedSignal = options.signal;
      await options.beforeProviderAttempt?.("exa");
      if (options.signal?.aborted) throw webSearchError("cancelled", "exa");
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw webSearchError("cancelled", "exa");
    },
  });
  const tool = webTool(host, authority());
  assert.ok(tool);
  const timeoutOperation = tool.execute("timeout", {
    query: "bounded query",
    numResults: 3,
  });
  scheduled[0]?.callback();
  assert.equal(await rejectionMessage(timeoutOperation), "Web search timed out.");
  assert.equal(observedSignal?.aborted, true);

  observedSignal = undefined;
  const caller = new AbortController();
  const cancelledOperation = tool.execute(
    "cancelled",
    { query: "bounded query", numResults: 3 },
    caller.signal,
  );
  caller.abort();
  assert.equal(await rejectionMessage(cancelledOperation), "Web search was cancelled.");
  assert.equal((observedSignal as AbortSignal | undefined)?.aborted, true);
});
