import type { BrowserDiagnostic, BrowserElement, BrowserSnapshot } from "../../../renderer/shared/browser.js";

/** Serialized text budgets use the same characters/4 estimate as generation context. */
export const BROWSER_SNAPSHOT_CONTEXT_LIMITS = {
  // Stay below generic oversized-tool truncation so it cannot cut failure
  // evidence out of the middle of this already structured projection.
  total: 32_000,
  pageText: 8_000,
  elements: 12_000,
  accessibility: 6_000,
  diagnostics: 3_000,
  console: 1_000,
  network: 3_000,
  actions: 3_000,
} as const;

interface BudgetCounts {
  elements: number;
  accessibilityNodes: number;
  diagnostics: number;
  consoleEntries: number;
  networkEntries: number;
  actions: number;
}
export interface BrowserSnapshotContextBudget {
  maxCharacters: number;
  serializedCharacters: number;
  estimatedTokens: number;
  truncatedStrings: number;
  duplicateConsoleEntries: number;
  omitted: BudgetCounts;
  omittedFailures: { diagnostics: number; consoleEntries: number; networkEntries: number; actions: number };
}
export interface BoundedBrowserSnapshot extends BrowserSnapshot { contextBudget: BrowserSnapshotContextBudget }

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const jsonLength = (value: unknown) => JSON.stringify(value).length;
const failure = (value: Record<string, unknown>) => Boolean(value.error || value.errorText || value.failed || value.failure) || /error|fatal|critical|failed|cancelled|canceled/i.test(String(value.level ?? value.status ?? "")) || (typeof value.status === "number" && value.status >= 400);

/** Images have an independent retention policy and do not count as serialized tool text. */
export function browserSnapshotTextCharacters(snapshot: BrowserSnapshot): number {
  const { image: _image, ...text } = snapshot;
  return jsonLength(text);
}

/**
 * Model-facing projection only: original snapshots, actionable native references,
 * annotation images, page state, diagnostics buffers and journals stay untouched.
 */
export function boundBrowserSnapshot(snapshot: BrowserSnapshot): BoundedBrowserSnapshot {
  const contextBudget: BrowserSnapshotContextBudget = {
    maxCharacters: BROWSER_SNAPSHOT_CONTEXT_LIMITS.total, serializedCharacters: 0, estimatedTokens: 0,
    truncatedStrings: 0, duplicateConsoleEntries: 0,
    omitted: { elements: 0, accessibilityNodes: 0, diagnostics: 0, consoleEntries: 0, networkEntries: 0, actions: 0 },
    omittedFailures: { diagnostics: 0, consoleEntries: 0, networkEntries: 0, actions: 0 },
  };
  // Bound serialized strings, including JSON escapes, while retaining both ends
  // of an error/stack trace. Locators are selected whole instead of string-cut.
  const text = (value: unknown, max: number): string => {
    const source = typeof value === "string" ? value : "";
    if (source.length <= max && jsonLength(source) <= max) return source;
    contextBudget.truncatedStrings += 1;
    const marker = "…[truncated]…";
    let low = 0, high = Math.min(source.length, max), result = marker;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const tail = Math.floor(size / 2);
      const candidate = source.slice(0, size - tail) + marker + (tail ? source.slice(-tail) : "");
      if (jsonLength(candidate) <= max) { result = candidate; low = size + 1; }
      else high = size - 1;
    }
    return result;
  };
  const tab = snapshot.tab;
  const result: BoundedBrowserSnapshot = {
    tab: {
      id: text(tab.id, 256), workspaceId: text(tab.workspaceId, 256), profileId: text(tab.profileId, 256),
      url: text(tab.url, 8_300), title: text(tab.title, 1_024),
      loading: tab.loading, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward,
      crashed: tab.crashed, audible: tab.audible, muted: tab.muted,
      viewport: { mode: tab.viewport.mode, width: tab.viewport.width, height: tab.viewport.height, ...(tab.viewport.deviceName ? { deviceName: text(tab.viewport.deviceName, 128) } : {}), ...(tab.viewport.ratioLocked !== undefined ? { ratioLocked: tab.viewport.ratioLocked } : {}) },
      appearance: tab.appearance, zoom: tab.zoom, recording: tab.recording,
      agentControlling: tab.agentControlling, floating: tab.floating,
      ...(tab.pictureInPicture !== undefined ? { pictureInPicture: tab.pictureInPicture } : {}),
      ...(tab.visible !== undefined ? { visible: tab.visible } : {}),
      ...(tab.error ? { error: text(tab.error, 2_000) } : {}),
    },
    text: text(snapshot.text, BROWSER_SNAPSHOT_CONTEXT_LIMITS.pageText),
    elements: [], diagnostics: [],
    ...(snapshot.image ? { image: snapshot.image } : {}), contextBudget,
  };
  // Leave room for field names and final measurement/omission metadata. Retain
  // failures first, then useful locators, before spending space on duplicate AX.
  let remaining = BROWSER_SNAPSHOT_CONTEXT_LIMITS.total - browserSnapshotTextCharacters(result) - 1_024;
  const select = <T>(items: T[], limit: number, priority: (item: T) => number, count: keyof BudgetCounts, recent: boolean, isFailure?: (item: T) => boolean): T[] => {
    const budget = Math.max(2, Math.min(limit, remaining));
    let used = 2;
    const chosen = new Set<number>();
    const ranked = items.map((item, index) => ({ item, index })).sort((a, b) => priority(b.item) - priority(a.item) || (recent ? b.index - a.index : a.index - b.index));
    for (const { item, index } of ranked) {
      const cost = jsonLength(item) + (chosen.size ? 1 : 0);
      if (used + cost > budget) continue;
      used += cost; chosen.add(index);
    }
    contextBudget.omitted[count] += items.length - chosen.size;
    if (isFailure && count in contextBudget.omittedFailures) contextBudget.omittedFailures[count as keyof typeof contextBudget.omittedFailures] += items.filter((item, index) => !chosen.has(index) && isFailure(item)).length;
    remaining -= used;
    return items.filter((_, index) => chosen.has(index));
  };
  const diagnostic = (raw: unknown): BrowserDiagnostic => {
    const value = object(raw);
    return { level: text(value.level ?? (failure(value) ? "error" : "info"), 64), message: text(value.message ?? value.error ?? value.errorText, 1_000), timestamp: number(value.timestamp) ?? 0 };
  };
  const diagnostics = snapshot.diagnostics.map(diagnostic);
  result.diagnostics = select(diagnostics, BROWSER_SNAPSHOT_CONTEXT_LIMITS.diagnostics, (entry) => failure(object(entry)) ? 2 : /warn/i.test(entry.level) ? 1 : 0, "diagnostics", true, (entry) => failure(object(entry)));
  const diagnosticKeys = new Set(diagnostics.map((entry) => JSON.stringify(entry)));
  const consoleEntries = (snapshot.consoleEntries ?? []).map(diagnostic).filter((entry) => {
    if (!diagnosticKeys.has(JSON.stringify(entry))) return true;
    contextBudget.duplicateConsoleEntries += 1; return false;
  });
  if (consoleEntries.length) result.consoleEntries = select(consoleEntries, BROWSER_SNAPSHOT_CONTEXT_LIMITS.console, (entry) => failure(object(entry)) ? 2 : /warn/i.test(entry.level) ? 1 : 0, "consoleEntries", true, (entry) => failure(object(entry)));
  const actions = (snapshot.actionTimeline ?? []).map((raw) => {
    const value = object(raw);
    return { id: text(value.id, 128), action: text(value.action, 128), status: text(value.status, 64), ...(value.error ? { error: text(value.error, 1_000) } : {}), startedAt: number(value.startedAt), completedAt: number(value.completedAt) };
  });
  result.actionTimeline = select(actions, BROWSER_SNAPSHOT_CONTEXT_LIMITS.actions, (entry) => failure(entry) ? 2 : entry.status === "running" ? 1 : 0, "actions", true, failure);
  const network = (snapshot.networkEntries ?? []).map((raw) => {
    const value = object(raw);
    return { url: text(value.url, 1_200), status: number(value.status), mimeType: text(value.mimeType, 96), ...(value.method ? { method: text(value.method, 32) } : {}), ...(value.error || value.errorText ? { error: text(value.error || value.errorText, 800) } : {}), ...(value.failed === true || value.failure === true ? { failed: true } : {}), timestamp: number(value.timestamp) };
  });
  result.networkEntries = select(network, BROWSER_SNAPSHOT_CONTEXT_LIMITS.network, (entry) => failure(entry) ? 1 : 0, "networkEntries", true, failure);
  const elements = snapshot.elements.map((entry): BrowserElement => ({
    ref: text(entry.ref, 128), tag: text(entry.tag, 48), ...(entry.role ? { role: text(entry.role, 64) } : {}),
    text: text(entry.text, 240), selector: entry.selector,
    bounds: { x: entry.bounds.x, y: entry.bounds.y, width: entry.bounds.width, height: entry.bounds.height },
    ...(entry.attributes ? { attributes: Object.fromEntries(Object.entries(entry.attributes).filter(([key]) => ["aria-label", "placeholder", "type", "name", "href", "data-testid"].includes(key)).map(([key, value]) => [key, text(value, 240)])) } : {}),
  }));
  result.elements = select(elements, BROWSER_SNAPSHOT_CONTEXT_LIMITS.elements, (entry) => /^(alert|status)$/.test(entry.role ?? "") ? 3 : /^(button|input|textarea|select)$/.test(entry.tag) || /^(button|textbox|checkbox|radio|combobox)$/.test(entry.role ?? "") ? 2 : entry.text ? 1 : 0, "elements", false);
  const scalar = (value: unknown, max = 256): string | boolean | number | undefined => {
    const raw = value && typeof value === "object" ? object(value).value : value;
    return typeof raw === "string" ? text(raw, max) : typeof raw === "boolean" ? raw : number(raw);
  };
  const rawNodes = Array.isArray(object(snapshot.accessibilityTree).nodes) ? object(snapshot.accessibilityTree).nodes as unknown[] : [];
  const nodes = rawNodes.flatMap((raw) => {
    const node = object(raw), role = scalar(node.role, 64), name = scalar(node.name, 384);
    if (node.ignored || role === "InlineTextBox" || (!name && (role === "none" || role === "generic")) || (role === "StaticText" && typeof name === "string" && result.text.includes(name))) { contextBudget.omitted.accessibilityNodes += 1; return []; }
    const properties = Array.isArray(node.properties) ? node.properties.flatMap((rawProperty) => {
      const property = object(rawProperty);
      if (!["checked", "disabled", "expanded", "focused", "invalid", "level", "multiselectable", "pressed", "readonly", "required", "selected", "valuemin", "valuemax", "valuetext"].includes(String(property.name))) return [];
      return [{ name: property.name, value: scalar(property.value, 128) }];
    }) : [];
    return [{ nodeId: text(node.nodeId, 64), backendDOMNodeId: number(node.backendDOMNodeId), parentId: scalar(node.parentId, 64), role, name, value: scalar(node.value), description: scalar(node.description, 256), ...(properties.length ? { properties } : {}) }];
  });
  result.accessibilityTree = { nodes: select(nodes, BROWSER_SNAPSHOT_CONTEXT_LIMITS.accessibility, (node) => ["alert", "status"].includes(String(node.role)) ? 3 : node.properties?.some((property) => property.name === "focused" && property.value === true) ? 2 : node.role === "RootWebArea" || node.name ? 1 : 0, "accessibilityNodes", false) };
  // Number width stabilizes after a second pass because this metadata is itself
  // part of the model-visible JSON. The 1KB reserve covers all added field names.
  for (let pass = 0; pass < 3; pass += 1) {
    contextBudget.serializedCharacters = browserSnapshotTextCharacters(result);
    contextBudget.estimatedTokens = Math.ceil(contextBudget.serializedCharacters / 4);
  }
  return result;
}
