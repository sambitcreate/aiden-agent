import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  BUILT_IN_BROWSER_PROFILES, DEFAULT_BROWSER_SETTINGS,
  type BrowserCommand, type BrowserCommandResult, type BrowserState, type BrowserTab,
} from "../../renderer/shared/browser.js";
import { BROWSER_TOOL_NAMES, canUseBrowserTools, createBrowserAgentTools, normalizeBrowserToolUrl } from "./browser-tools.js";

test("native browser tools require a foreground ordinary workspace rather than a Bot adapter or headless owner", () => {
  const input = { permission: "full", rendererOwner: true, assistantMode: false, bot: false };
  assert.equal(canUseBrowserTools(input), true);
  assert.equal(canUseBrowserTools({ ...input, permission: "ask" }), true);
  for (const override of [{ rendererOwner: false }, { bot: true }, { assistantMode: true }, { permission: "none" }, { permission: "read-only" }]) assert.equal(canUseBrowserTools({ ...input, ...override }), false);
});

function tab(id: string): BrowserTab {
  return { id, workspaceId: "workspace", profileId: "default", url: "https://example.test/", title: id,
    loading: false, canGoBack: false, canGoForward: false, crashed: false, audible: false, muted: false,
    viewport: { mode: "fill", width: 1280, height: 720 }, appearance: "system", zoom: 1, recording: false,
    agentControlling: false, floating: false, visible: true };
}
function harness(options: { supportsImages?: boolean; empty?: boolean } = {}) {
  const abort = new AbortController();
  let state: BrowserState = { workspaceId: "workspace", revision: 1, agentAccessOverride: "inherit", agentAccessAllowed: true,
    tabs: options.empty ? [] : [tab("first"), tab("second")], activeTabId: options.empty ? null : "first",
    profiles: structuredClone(BUILT_IN_BROWSER_PROFILES), defaults: structuredClone(DEFAULT_BROWSER_SETTINGS), history: [], servers: [] };
  const calls: BrowserCommand[] = [];
  let handler: ((command: BrowserCommand, signal: AbortSignal) => Promise<BrowserCommandResult>) | undefined;
  const tools = createBrowserAgentTools({ workspaceId: "workspace", chatId: "chat", generationId: "generation",
    signal: abort.signal, supportsImages: options.supportsImages ?? true,
    port: {
      getState: () => state,
      command: async (command, signal) => {
        calls.push(command);
        if (handler) return handler(command, signal);
        if (command.action === "create") {
          const created = { ...tab(`created-${calls.length}`), visible: command.show !== false };
          state = { ...state, tabs: [...state.tabs, created] };
          return { state, tabId: created.id };
        }
        if (command.action === "snapshot") return { state, snapshot: { tab: state.tabs.find(({ id }) => id === command.tabId)!, text: "Example", elements: [], diagnostics: [], accessibilityTree: { nodes: [] }, networkEntries: [{ status: 200 }], actionTimeline: [], image: { mimeType: "image/png", data: "image-base64", width: 100, height: 100 } } };
        if (command.action === "evaluate") return { state, value: { title: "Example" } };
        return { state };
      },
    },
  });
  return { abort, calls, tools,
    get state() { return state; },
    setState(next: BrowserState) { state = next; },
    setHandler(next: typeof handler) { handler = next; },
    call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, name);
      return tool.execute("call", args, signal);
    },
  };
}
function output(result: AgentToolResult<unknown>) {
  const content = result.content.find((part) => part.type === "text");
  assert.ok(content?.type === "text");
  return JSON.parse(content.text);
}

test("workspace browser access overrides global defaults and inherit follows the global policy", async () => {
  const h = harness();
  h.setState({ ...h.state, defaults: { ...h.state.defaults, agentAccess: "off" }, agentAccessOverride: "allow" });
  await h.call("browser_snapshot", { includeImage: false });
  h.setState({ ...h.state, agentAccessOverride: "inherit" });
  await assert.rejects(h.call("browser_snapshot", { includeImage: false }), /disabled/);
  h.setState({ ...h.state, defaults: { ...h.state.defaults, agentAccess: "allow" }, agentAccessOverride: "off" });
  await assert.rejects(h.call("browser_snapshot", { includeImage: false }), /disabled/);
});

test("exposes the complete 14-operation reference browser surface", () => {
  const h = harness();
  assert.deepEqual(h.tools.map(({ name }) => name), BROWSER_TOOL_NAMES);
  for (const tool of h.tools) assert.equal((tool.parameters as { additionalProperties?: boolean }).additionalProperties, false);
});

test("pins default tab per generation and only changes it after a successful explicit target", async () => {
  const h = harness();
  assert.equal(output(await h.call("browser_status")).tabId, "first");
  h.setState({ ...h.state, activeTabId: "second" });
  await h.call("browser_click", { x: 10, y: 20 });
  assert.equal((h.calls[h.calls.length - 1] as { tabId: string }).tabId, "first");
  await h.call("browser_snapshot", { tabId: "second", includeImage: false });
  await h.call("browser_type", { text: "hello" });
  assert.equal((h.calls[h.calls.length - 1] as { tabId: string }).tabId, "second");
  await assert.rejects(h.call("browser_click", { tabId: "foreign", x: 1, y: 1 }), /does not belong/);
  assert.equal(output(await h.call("browser_status")).tabId, "second");
});

test("does not switch to another tab after the generation's tab closes", async () => {
  const h = harness();
  await h.call("browser_status");
  h.setState({ ...h.state, tabs: [tab("second")], activeTabId: "second" });
  await assert.rejects(h.call("browser_type", { text: "private" }), /browser_open/);
  assert.equal(h.calls.length, 0);
});

test("opens hidden tabs and correlates the exact new tab amid another generation's create", async () => {
  const h = harness({ empty: true });
  h.setHandler(async () => ({ state: { ...h.state, tabs: [tab("other-generation"), { ...tab("mine"), visible: false }] }, tabId: "mine" }));
  const result = output(await h.call("browser_open", { url: "localhost:5173", open: false }));
  assert.equal(result.tabId, "mine");
  assert.equal(result.visible, false);
  assert.deepEqual(h.calls[0], { action: "create", url: "http://localhost:5173/", show: false });
});

test("rejects cross-workspace state before any action", async () => {
  const h = harness();
  h.setState({ ...h.state, workspaceId: "other" });
  await assert.rejects(h.call("browser_open"), /authority changed/);
  assert.equal(h.calls.length, 0);
});

test("checks agent-access revocation for every invocation", async () => {
  const h = harness();
  await h.call("browser_status");
  h.setState({ ...h.state, defaults: { ...h.state.defaults, agentAccess: "off" } });
  await assert.rejects(h.call("browser_type", { text: "private" }), /disabled/);
  assert.equal(h.calls.length, 0);
});

test("revalidates generation authority after the asynchronous state read before dispatch", async () => {
  const h = harness();
  let current = true;
  const calls: BrowserCommand[] = [];
  const tools = createBrowserAgentTools({ workspaceId: "workspace", chatId: "chat", generationId: "generation", signal: new AbortController().signal, supportsImages: true,
    revalidate: async () => { if (!current) throw new Error("Workspace access changed"); },
    port: { getState: async () => { current = false; return h.state; }, command: async (command) => { calls.push(command); return { state: h.state }; } },
  });
  await assert.rejects(tools.find(({ name }) => name === "browser_type")!.execute("call", { text: "private" }), /Workspace access changed/);
  assert.equal(calls.length, 0);
});

test("cancelled generations and tool calls cannot dispatch and stale results are discarded", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort(new Error("call cancelled"));
  await assert.rejects(h.call("browser_snapshot", {}, controller.signal), /call cancelled/);
  assert.equal(h.calls.length, 0);
  h.setHandler(async (_command, signal) => { h.abort.abort(new Error("generation ended")); assert.equal(signal.aborted, true); return { state: h.state }; });
  await assert.rejects(h.call("browser_click", { x: 5, y: 5 }), /generation ended/);
  await assert.rejects(h.call("browser_open"), /generation ended/);
  assert.equal(h.calls.length, 1);
});

test("serializes concurrent actions and recovers the queue after failure", async () => {
  const h = harness();
  let resolveFirst!: () => void;
  const started = new Promise<void>((resolve) => { resolveFirst = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  h.setHandler(async (command) => { if (command.action === "click") { resolveFirst(); await blocked; throw new Error("covered"); } return { state: h.state }; });
  const first = h.call("browser_click", { x: 10, y: 20 });
  const rejected = assert.rejects(first, /covered/);
  await started;
  const second = h.call("browser_type", { text: "after" });
  assert.equal(h.calls.length, 1);
  const secondRejected = assert.rejects(second, /fresh snapshot/);
  release();
  await rejected;
  await secondRejected;
  await h.call("browser_type", { text: "fresh request" });
  assert.equal(h.calls[1]?.action, "type");
});

test("snapshot returns image separately and keeps all page diagnostics in text-only output", async () => {
  const h = harness();
  const result = await h.call("browser_snapshot");
  assert.equal(result.content.filter(({ type }) => type === "image").length, 1);
  assert.equal(output(result).image, undefined);
  assert.equal(output(result).networkEntries[0].status, 200);
  assert.ok(output(result).contextBudget.serializedCharacters <= 32000);
  const textOnly = await h.call("browser_snapshot", { includeImage: false });
  assert.equal(textOnly.content.filter(({ type }) => type === "image").length, 0);
  assert.deepEqual(output(textOnly).accessibilityTree, { nodes: [] });
  const nonVision = harness({ supportsImages: false });
  assert.equal((await nonVision.call("browser_snapshot")).content.length, 1);
  assert.equal((nonVision.calls[0] as { includeImage: boolean }).includeImage, false);
});

test("navigation preserves readiness and confines environment-port paths", async () => {
  const h = harness();
  await h.call("browser_navigate", { target: { kind: "environment-port", port: 5173, path: "/settings?x=1#top" }, readiness: "domContentLoaded", timeoutMs: 1000 });
  assert.deepEqual(h.calls[0], { action: "navigate", tabId: "first", url: "http://localhost:5173/settings?x=1#top", readiness: "domContentLoaded", timeoutMs: 1000 });
  for (const path of ["//evil.test", "https://evil.test", "\\evil.test"]) await assert.rejects(h.call("browser_navigate", { target: { kind: "environment-port", port: 5173, path } }), /selected local server/);
});

test("semantic targets, key modifiers, scroll containers and evaluation options reach the same tab", async () => {
  const h = harness();
  await h.call("browser_click", { locator: "role=button[name='Save']", timeoutMs: 500 });
  await h.call("browser_type", { selector: "textarea", text: "literal", clear: true });
  await h.call("browser_press", { key: "Enter", modifiers: ["Meta", "Shift"] });
  await h.call("browser_scroll", { locator: "role=list", deltaY: 400 });
  assert.deepEqual(output(await h.call("browser_evaluate", { expression: "document.title", awaitPromise: false, returnByValue: false })), { title: "Example" });
  await h.call("browser_wait_for", { locator: "text=Done", text: "Saved", urlIncludes: "/saved", timeoutMs: 800 });
  assert.ok(h.calls.every((command) => "tabId" in command && command.tabId === "first"));
  assert.deepEqual(h.calls[2], { action: "press", tabId: "first", key: "Enter", modifiers: ["Meta", "Shift"] });
  assert.equal((h.calls[3] as { locator: string }).locator, "role=list");
  assert.equal((h.calls[4] as { returnByValue: boolean }).returnByValue, false);
  assert.equal((h.calls[5] as { urlIncludes: string }).urlIncludes, "/saved");
});

test("rejects ambiguous targets, invalid limits, unsupported URLs and injected scope before dispatch", async () => {
  const h = harness();
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["browser_click", { x: 1 }], ["browser_click", { locator: "button", selector: "button" }],
    ["browser_click", { selector: "button", x: 1, y: 2 }], ["browser_click", { x: Infinity, y: 2 }],
    ["browser_click", { x: NaN, y: 2 }], ["browser_scroll", {}], ["browser_wait_for", {}],
    ["browser_open", { tabId: "first", reuseExistingTab: false }],
    ["browser_open", { url: "javascript:alert(1)" }],
    ["browser_navigate", { url: "example.test", target: { kind: "url", url: "other.test" } }],
    ["browser_navigate", { url: "example.test", timeoutMs: 60001 }],
    ["browser_type", { text: "test", workspaceId: "other" }],
    ["browser_resize", { mode: "fill", width: 400, height: 300 }],
    ["browser_resize", { mode: "freeform", width: 3840, height: 3840 }],
    ["browser_resize", { mode: "preset", preset: "invented" }],
  ];
  for (const [name, args] of invalid) await assert.rejects(h.call(name, args), { name: "Error" }, `${name}: ${JSON.stringify(args)}`);
  assert.equal(h.calls.length, 0);
});

test("device presets preserve exact CSS size and orientation", async () => {
  const h = harness();
  await h.call("browser_resize", { mode: "preset", preset: "iphone-12-pro", orientation: "landscape" });
  assert.deepEqual(h.calls[0], { action: "viewport", tabId: "first", viewport: { mode: "responsive", width: 844, height: 390, deviceName: "iPhone 12 Pro" } });
});

test("URL normalization distinguishes host ports from unsafe protocols", () => {
  assert.equal(normalizeBrowserToolUrl("example.com:8443/path"), "https://example.com:8443/path");
  assert.equal(normalizeBrowserToolUrl("localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeBrowserToolUrl("[::1]:5173"), "http://[::1]:5173/");
  assert.throws(() => normalizeBrowserToolUrl("file:///etc/passwd"), /HTTP/);
});

test("a failed or interrupted browser call invalidates already queued actions but permits a fresh inspection", async () => {
  const h = harness();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  h.setHandler(async () => { await blocked; throw new Error("User interrupted browser control"); });
  const first = h.call("browser_click", { x: 1, y: 1 });
  const second = h.call("browser_type", { text: "must not type" });
  const failures = Promise.all([assert.rejects(first, /interrupted/), assert.rejects(second, /fresh snapshot/)]);
  release();
  await failures;
  assert.equal(h.calls.length, 1);
  h.setHandler(undefined);
  await h.call("browser_snapshot", { includeImage: false });
  assert.equal(h.calls[h.calls.length - 1]?.action, "snapshot");
});

test("local documents use managed previews, preserve tab reuse and reject ambiguous file authority", async () => {
  const h = harness();
  h.setHandler(async (command) => {
    assert.equal(command.action, "open_file");
    return { state: h.state, tabId: "first" };
  });
  for (const args of [
    { path: "/tmp/sample.html", assetPaths: ["/tmp/style.css"] },
    { url: "file:///tmp/sample.html" },
    { url: "/tmp/sample.html" },
  ]) {
    const result = output(await h.call("browser_open", args));
    assert.equal(result.tabId, "first");
    assert.equal(h.calls[h.calls.length - 1]?.action, "open_file");
    assert.equal((h.calls[h.calls.length - 1] as { path: string }).path, "/tmp/sample.html");
    assert.equal((h.calls[h.calls.length - 1] as { tabId: string }).tabId, "first");
  }
  await h.call("browser_navigate", { path: "preview.html", readiness: "domContentLoaded" });
  assert.equal((h.calls[h.calls.length - 1] as { readiness: string }).readiness, "domContentLoaded");
  for (const args of [{ path: "/tmp/sample.html", url: "https://example.test" }, { url: "https://example.test", assetPaths: ["secret"] }, { url: "file://other-host/tmp/sample.html" }]) {
    await assert.rejects(h.call("browser_open", args));
  }
  assert.equal(h.calls.length, 4);
});
