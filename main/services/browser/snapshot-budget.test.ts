import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_SNAPSHOT_CONTEXT_LIMITS, boundBrowserSnapshot, browserSnapshotTextCharacters } from "./snapshot-budget.js";
import type { BrowserElement, BrowserSnapshot } from "../../../renderer/shared/browser.js";
import { DEFAULT_BROWSER_SETTINGS } from "../../../renderer/shared/browser.js";

function snapshot(): BrowserSnapshot {
  return { tab: { id: "tab", workspaceId: "workspace", profileId: "default", url: "https://example.com/page", title: "Example", loading: false, canGoBack: false, canGoForward: false, crashed: false, audible: false, muted: false, viewport: DEFAULT_BROWSER_SETTINGS.viewport, appearance: "system", zoom: 1, recording: false, agentControlling: false, floating: false }, text: "Save your changes", elements: [{ ref: "1-0", tag: "button", role: "button", text: "Save", selector: "internal:role=button[name=\"Save\"i]", bounds: { x: 10, y: 20, width: 100, height: 30 } }], diagnostics: [] };
}

test("small snapshots preserve URL, title, whole locators, current image and original journal input", () => {
  const original = snapshot();
  original.image = { data: "current-image", mimeType: "image/png", width: 100, height: 200 };
  const serialized = JSON.stringify(original);
  const result = boundBrowserSnapshot(original);
  assert.equal(result.tab.url, original.tab.url); assert.equal(result.tab.title, original.tab.title);
  assert.deepEqual(result.elements, original.elements);
  assert.equal(result.image, original.image);
  assert.equal(JSON.stringify(original), serialized);
  assert.equal(result.contextBudget.serializedCharacters, browserSnapshotTextCharacters(result));
  assert.equal(result.contextBudget.estimatedTokens, Math.ceil(browserSnapshotTextCharacters(result) / 4));
});

test("large snapshots have a measured total text budget including escaped strings and omission metadata", () => {
  const original = snapshot();
  original.text = '"\\\n'.repeat(10_000);
  original.tab.favicon = `data:image/png;base64,${"a".repeat(100_000)}`;
  original.elements = Array.from({ length: 200 }, (_, index): BrowserElement => ({ ...original.elements[0]!, ref: `1-${index}`, selector: `#control-${index}`, text: "Long element text ".repeat(300), attributes: { "aria-label": "A useful label".repeat(100), "data-testid": `control-${index}`, "style:background-image": "discard duplicate styling".repeat(1000) } }));
  original.diagnostics = Array.from({ length: 200 }, (_, index) => ({ level: "info", message: `message-${index}${"x".repeat(4_000)}`, timestamp: index }));
  original.consoleEntries = structuredClone(original.diagnostics);
  original.networkEntries = Array.from({ length: 200 }, (_, index) => ({ status: 200, url: `https://example.com/${index}/${"x".repeat(3_000)}`, timestamp: index }));
  original.actionTimeline = Array.from({ length: 200 }, (_, index) => ({ id: `action-${index}`, action: "click", status: "succeeded", startedAt: index, completedAt: index + 1, duplicatedPayload: "x".repeat(10_000) }));
  original.accessibilityTree = { nodes: Array.from({ length: 1000 }, (_, index) => ({ nodeId: `${index}`, role: { value: "button", sources: ["duplicate".repeat(1000)] }, name: { value: `Button-${index}${"long".repeat(200)}`, sources: ["duplicate".repeat(1000)] }, backendDOMNodeId: index, ignored: false, properties: [{ name: "focused", value: { value: index === 999 } }] })) };
  const before = JSON.stringify(original);
  const result = boundBrowserSnapshot(original);
  assert.ok(browserSnapshotTextCharacters(result) <= BROWSER_SNAPSHOT_CONTEXT_LIMITS.total);
  assert.ok(result.contextBudget.estimatedTokens <= 8_000);
  assert.equal(result.contextBudget.serializedCharacters, browserSnapshotTextCharacters(result));
  assert.ok(result.contextBudget.omitted.elements > 0); assert.ok(result.contextBudget.omitted.accessibilityNodes > 0);
  assert.ok(result.contextBudget.truncatedStrings > 0);
  assert.equal(result.contextBudget.duplicateConsoleEntries, 200);
  assert.equal(result.consoleEntries, undefined); assert.equal(result.tab.favicon, undefined);
  assert.ok(result.elements.every((element) => /^#control-\d+$/.test(element.selector)));
  assert.equal(JSON.stringify(original), before);
  assert.ok(browserSnapshotTextCharacters(result) < before.length / 50);
});

test("old sole failures survive newer successes in diagnostics, network and action outcomes", () => {
  const original = snapshot();
  original.tab.error = "The page failed to load";
  original.diagnostics = [{ level: "error", message: "Only login failure evidence", timestamp: 1 }, ...Array.from({ length: 199 }, (_, index) => ({ level: "info", message: `noise ${index} ${"x".repeat(1000)}`, timestamp: index + 2 }))];
  original.networkEntries = [{ url: "https://example.com/login", status: 401, timestamp: 1 }, { url: "https://example.com/disconnected", failed: true, timestamp: 1 }, ...Array.from({ length: 199 }, (_, index) => ({ url: `https://example.com/asset/${index}`, status: 200, timestamp: index + 2 }))];
  original.actionTimeline = [{ id: "failed-click", action: "click", status: "failed", error: "Element is covered", startedAt: 1 }, ...Array.from({ length: 199 }, (_, index) => ({ id: `later-${index}`, action: "snapshot", status: "succeeded", startedAt: index + 2 }))];
  const result = boundBrowserSnapshot(original);
  assert.equal(result.tab.error, original.tab.error);
  assert.ok(result.diagnostics.some((entry) => entry.message === "Only login failure evidence"));
  assert.ok(result.networkEntries!.some((entry) => (entry as { status: number }).status === 401));
  assert.ok(result.networkEntries!.some((entry) => (entry as { failed?: boolean }).failed === true));
  assert.ok(result.actionTimeline!.some((entry) => (entry as { error: string }).error === "Element is covered"));
  assert.deepEqual(result.contextBudget.omittedFailures, { diagnostics: 0, consoleEntries: 0, networkEntries: 0, actions: 0 });
});

test("accessibility projection keeps alerts and focused state while removing duplicate static page text", () => {
  const original = snapshot();
  original.accessibilityTree = { nodes: [
    { nodeId: "static", role: { value: "StaticText" }, name: { value: "Save your changes" } },
    { nodeId: "hidden", role: { value: "button" }, name: { value: "Hidden" }, ignored: true },
    { nodeId: "alert", backendDOMNodeId: 3, role: { value: "alert" }, name: { value: "Payment failed" } },
    { nodeId: "focused", parentId: "root", role: { value: "textbox" }, name: { value: "Card number" }, properties: [{ name: "focused", value: { value: true } }, { name: "disabled", value: { value: false } }] },
  ] };
  const result = boundBrowserSnapshot(original);
  const nodes = (result.accessibilityTree as { nodes: Array<Record<string, unknown>> }).nodes;
  assert.deepEqual(nodes.map((node) => node.nodeId), ["alert", "focused"]);
  assert.equal(nodes[0]?.name, "Payment failed");
  assert.deepEqual(nodes[1]?.properties, [{ name: "focused", value: true }, { name: "disabled", value: false }]);
  assert.equal(result.contextBudget.omitted.accessibilityNodes, 2);
});

test("oversized locators are omitted whole and a later useful locator still fits", () => {
  const original = snapshot();
  const usable = original.elements[0]!;
  original.elements = [{ ...usable, ref: "huge", selector: `#${"x".repeat(50_000)}` }, usable];
  const result = boundBrowserSnapshot(original);
  assert.deepEqual(result.elements.map((element) => element.selector), [usable.selector]);
  assert.equal(result.contextBudget.omitted.elements, 1);
});
