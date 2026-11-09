// Desktop Settings → Storage: the profile inventory.
//
// The scanner measures every top-level entry of Aiden's device-local user-data
// profile, so the total covers the whole profile. This table only decides which
// category an entry is shown under; anything it does not name is "Other app
// data". Naming an entry here never makes it removable: each cleanup action
// goes through the feature that owns the data.

import type { StorageCategoryId } from "../../renderer/shared/storage.js";

/** Top-level profile entries, by the category the page shows them under. */
export const STORAGE_PROFILE_LAYOUT: Readonly<Record<string, StorageCategoryId>> = {
  // Worktrees and their restorable snapshots.
  worktrees: "worktrees",
  "worktree-snapshots": "snapshots",

  // Chats: transcripts, their image files, private per-chat runtime stores, and
  // Bots' conversations and memory.
  chats: "threads",
  "pi-compaction-sessions": "threads",
  "pi-runtime-effects.json": "threads",
  "subagent-runs": "threads",
  "subagent-runs-v2": "threads",
  "tool-output-spills.json": "threads",
  "display-image-artifacts.json": "threads",
  "generative-ui-artifacts.json": "threads",
  "chat-pull-requests": "threads",
  "chat-folders": "threads",
  "follow-through": "threads",
  "interrupted-waits.json": "threads",
  "chat-triage.json": "threads",
  "chat-read-markers.json": "threads",
  "first-message-worktrees.json": "threads",
  bots: "threads",
  memory: "threads",

  // Long-lived generated output.
  "workspace-artifacts": "artifacts",
  "create-images": "artifacts",
  "studio-assets": "artifacts",
  "design-projects": "artifacts",

  // App output the person can always live without.
  logs: "logs",
  Crashpad: "logs",
  "terminal-history": "logs",

  // The built-in browser's and Bots' browsers' Chromium profiles, browser
  // recordings, and the app's own Chromium caches (cleared by Clear cache too).
  Partitions: "browser",
  browser: "browser",
  Cache: "browser",
  "Code Cache": "browser",
  GPUCache: "browser",

  // Downloaded models and Bot computers.
  "voice-models": "models",
  "parakeet-models": "models",
  "form-fill-model": "models",
  "bot-computers": "bot-computers",
};

export function storageCategoryForEntry(name: string): StorageCategoryId {
  return Object.prototype.hasOwnProperty.call(STORAGE_PROFILE_LAYOUT, name) ? STORAGE_PROFILE_LAYOUT[name]! : "other";
}

/**
 * Chromium cache folders inside a browser profile that Clear cache empties:
 * cached pages and files, compiled scripts and GPU shaders. Cookies, local
 * storage and service-worker data are never touched, so sign-ins survive.
 */
export const BROWSER_CACHE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
]);

/**
 * The browser partitions Aiden creates (`persist:aiden-browser-*` for the
 * workspace browser, `persist:aiden-bot-*` for Bots, whose names escape other
 * characters as `~xx`). Only these are counted and cleared; a folder name
 * outside this pattern is left alone.
 */
const AIDEN_PARTITION_DIRECTORY = /^aiden-(?:browser|bot)-[A-Za-z0-9_~-]{1,200}$/u;

export function aidenBrowserPartitionName(directoryName: string): string | null {
  return AIDEN_PARTITION_DIRECTORY.test(directoryName) ? `persist:${directoryName}` : null;
}
