import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return value.slice(startIndex, endIndex);
}

test("sidebar places New Agent above Scheduled beneath search", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const sidebarBody = between(sidebar, "<Sidebar", "</Sidebar>");
  const newAgentIndex = sidebarBody.indexOf("New Agent");
  const scheduledIndex = sidebarBody.indexOf('title="Scheduled"');
  const workspaceIndex = sidebarBody.indexOf("Workspace switcher");

  assert.notEqual(newAgentIndex, -1);
  assert.notEqual(scheduledIndex, -1);
  assert.ok(newAgentIndex < scheduledIndex, "New Agent should appear before Scheduled");
  assert.ok(
    scheduledIndex < workspaceIndex,
    "Scheduled should stay above the workspace switcher and chat list",
  );
});

test("new agent uses the same sidebar row style as scheduled", () => {
  const sidebar = source("./chat-sidebar.tsx");
  const section = between(sidebar, '<div className="flex flex-col gap-0.5 px-2.5 pb-2">', "</div>");
  assert.match(section, /<SidebarListItem[\s\S]*title="New Agent"/u);
  assert.match(section, /<SidebarListItem[\s\S]*title="Scheduled"/u);
  assert.doesNotMatch(section, /variant="accent"/u);
});

test("newAgent creates a chat in the active workspace", () => {
  const sidebar = source("./chat-sidebar.tsx");
  assert.match(sidebar, /const newAgent = React\.useCallback\(async \(\) => \{/u);
  assert.match(sidebar, /if \(!activeId\) return;/u);
  assert.match(sidebar, /chatsApi\.create\(\{ workspaceId: activeId \}\)/u);
  assert.match(
    sidebar,
    /navigate\(\{ to: "\/chat\/\$chatId", params: \{ chatId: created\.id \} \}\)/u,
  );
});

test("chat pane toolbar no longer exposes a duplicate new-chat control", () => {
  const pane = source("../main/chat-pane.tsx");
  assert.doesNotMatch(pane, /SquarePen/u);
  assert.doesNotMatch(pane, /aria-label="New chat"/u);
  assert.doesNotMatch(pane, /\bnewChat\b/u);
});

test("workspace menu middle-truncates folder paths", () => {
  const sidebar = source("./chat-sidebar.tsx");
  assert.match(sidebar, /import \{ truncatePathMiddle \} from "\.\.\/lib\/truncate-path"/u);
  assert.match(sidebar, /sublabel=\{\s*w\.folderPath \? truncatePathMiddle\(w\.folderPath\) : undefined\s*\}/u);
  assert.match(sidebar, /title=\{w\.folderPath \?\? undefined\}/u);
});

test("settings reuses the chat sidebar width so the chrome does not jump", () => {
  const settings = source("../main/settings-view.tsx");
  const chat = source("../main/chat-layout.tsx");
  assert.match(chat, /storageKey="aiden-agent"/u);
  assert.match(chat, /sidebarSize=\{\{ default: 272, min: 236, max: 340 \}\}/u);
  assert.match(settings, /storageKey="aiden-agent"/u);
  assert.match(settings, /sidebarSize=\{\{ default: 272, min: 236, max: 340 \}\}/u);
  assert.doesNotMatch(settings, /aiden-agent-settings/u);
});

test("sidebar list items use a fill focus state instead of a focus ring", () => {
  const ui = source("./ui.tsx");
  const item = between(ui, "export function SidebarListItem", "\n}");
  assert.match(item, /focus-visible:bg-list-selection/u);
  assert.doesNotMatch(item, /focus-visible:ring/u);
});

test("shared controls use theme fill or border focus instead of focus rings", () => {
  const ui = source("./ui.tsx");
  const button = between(ui, "export const Button =", "});");
  const input = between(ui, "export const Input =", "});");
  assert.match(button, /focus-visible:bg-list-selection/u);
  assert.match(button, /focus-visible:bg-control-active/u);
  assert.match(button, /focus-visible:bg-accent-hover/u);
  assert.doesNotMatch(button, /focus-visible:ring/u);
  assert.match(input, /focus:border-focus-ring/u);
  assert.match(input, /focus:bg-input/u);
  assert.doesNotMatch(input, /focus:ring-/u);
  assert.doesNotMatch(ui, /focus-visible:ring-focus-ring/u);
  assert.doesNotMatch(ui, /focus:ring-focus-ring/u);
});
