import { isHtmlArtifactTitle } from "../generative-ui.js";
import {
  AIDEN_UI_CATALOG_VERSION,
  AIDEN_UI_LIMITS,
  type AidenUiNodeV1,
  type ChatUiVisualV1,
} from "./types.js";

/**
 * Keys the shipped Aiden Remote clients treat as private anywhere in a chat
 * response (iOS `normalizedPrivateKeys` and `forbiddenWireKeys`, Android's
 * private response validator, desktop's child-projection guard). A visual
 * carrying one would make an older phone reject the whole chat.
 */
const PRIVATE_KEYS = new Set([
  "credential", "credentials", "secret", "secrets", "apikey", "token", "accesstoken",
  "refreshtoken", "header", "headers", "endpoint", "path", "prompt", "instructions",
  "openinggreeting", "argument", "arguments", "args", "toolargument", "toolarguments",
  "toolargs", "result", "results", "toolresult", "toolresults", "reasoning",
  "reasoningcontent", "authorization", "credentialdigest", "providerfingerprint",
  "mcpserverbindings", "folderpath", "repositorypath", "worktreepath", "worktreegitdir",
  "ownershiptoken", "worktreedevice", "worktreeinode", "createdfromhead", "canonicalpath",
  "absolutepath", "scriptpath", "environment", "stdout", "stderr", "managedhomepath",
  "managedworkspacepath", "workspacepath", "bothomepath", "systemprompt", "skillcontent",
  "skillcontents", "skillpath", "skillpaths", "providercredential", "mcpcredential",
  "connectioncredential", "authorizationheader", "providerheaders", "mcpheaders",
  "connectionheaders", "providerapikey", "mcpapikey", "connectionapikey",
  "credentialmaterial", "assetfilename", "avatarassetfilename", "temporaryasseturl",
  "temporaryurl",
]);

/** Any `child…`/`subagent…` compound is reserved for subagent projections. */
const PRIVATE_PREFIXES = ["child", "subagent"];

const VISUAL_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const TOOL_CALL_ID = /^call-\d{1,9}$/u;

export function isWireSafeKey(name: string): boolean {
  const normalized = name.replace(/[-_.\s]/gu, "").toLowerCase();
  if (PRIVATE_KEYS.has(normalized)) return false;
  return !PRIVATE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Every object key reachable from `value` is wire-safe. */
function keysAreWireSafe(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.every((item) => keysAreWireSafe(item, depth + 1));
  if (!isRecord(value)) return true;
  for (const [key, inner] of Object.entries(value)) {
    if (!isWireSafeKey(key) || !keysAreWireSafe(inner, depth + 1)) return false;
  }
  return true;
}

function isPropValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.op === "string" || typeof value.act === "string";
}

/** Shape-checks a tree, counting nodes; returns false past the caps. */
function isTree(node: unknown, depth: number, counter: { nodes: number }): node is AidenUiNodeV1 {
  if (!isRecord(node) || typeof node.t !== "string" || typeof node.k !== "string") return false;
  if (node.t.length === 0 || node.t.length > 64 || node.k.length > 256) return false;
  counter.nodes += 1;
  if (counter.nodes > AIDEN_UI_LIMITS.nodes || depth > AIDEN_UI_LIMITS.depth) return false;
  if (node.s !== undefined && typeof node.s !== "string") return false;
  if (node.e !== undefined && !isPropValue(node.e)) return false;
  if (node.p !== undefined) {
    if (!isRecord(node.p) || !Object.values(node.p).every(isPropValue)) return false;
  }
  if (node.c !== undefined) {
    if (!Array.isArray(node.c)) return false;
    for (const child of node.c) if (!isTree(child, depth + 1, counter)) return false;
  }
  return true;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Strict for one entry: returns a fresh object with known keys only. */
export function parseChatUiVisualV1(value: unknown): ChatUiVisualV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1 || value.kind !== "ui") return undefined;
  if (typeof value.id !== "string" || !VISUAL_ID.test(value.id)) return undefined;
  if (!isHtmlArtifactTitle(value.title)) return undefined;
  if (value.catalogVersion !== AIDEN_UI_CATALOG_VERSION) return undefined;
  if (value.toolCallId !== undefined && (typeof value.toolCallId !== "string" || !TOOL_CALL_ID.test(value.toolCallId))) {
    return undefined;
  }
  if (typeof value.fallbackText !== "string" || value.fallbackText.length > AIDEN_UI_LIMITS.fallbackChars) {
    return undefined;
  }
  if (!isTree(value.tree, 0, { nodes: 0 }) || !keysAreWireSafe(value.tree)) return undefined;
  if (byteLength(JSON.stringify(value.tree)) > AIDEN_UI_LIMITS.treeBytes) return undefined;
  if (value.dataJson !== undefined) {
    if (typeof value.dataJson !== "string" || byteLength(value.dataJson) > AIDEN_UI_LIMITS.dataBytes) return undefined;
  }
  if (value.state !== undefined) {
    if (!isRecord(value.state) || !keysAreWireSafe(value.state)) return undefined;
    if (byteLength(JSON.stringify(value.state)) > AIDEN_UI_LIMITS.stateBytes) return undefined;
  }
  return {
    version: 1,
    kind: "ui",
    id: value.id,
    ...(value.toolCallId !== undefined ? { toolCallId: value.toolCallId as string } : {}),
    title: value.title,
    catalogVersion: AIDEN_UI_CATALOG_VERSION,
    tree: value.tree,
    ...(value.dataJson !== undefined ? { dataJson: value.dataJson as string } : {}),
    ...(value.state !== undefined ? { state: value.state as Record<string, unknown> } : {}),
    fallbackText: value.fallbackText,
    ...(value.layout === "wide" ? { layout: "wide" as const } : {}),
  };
}

/** Lenient on purpose: one bad visual never hides the others on its message. */
export function parseChatUiVisuals(value: unknown): ChatUiVisualV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const visuals: ChatUiVisualV1[] = [];
  for (const entry of value.slice(0, AIDEN_UI_LIMITS.perChat)) {
    const visual = parseChatUiVisualV1(entry);
    if (!visual || seen.has(visual.id)) continue;
    seen.add(visual.id);
    visuals.push(visual);
  }
  return visuals.length ? visuals : undefined;
}
