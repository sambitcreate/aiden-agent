import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("manual automation editor binds exact MCP switches to Full permission", () => {
  const editor = source("../components/scheduled-task-editor.tsx");
  assert.match(editor, /label="MCP tools"/u);
  assert.match(editor, /mcpServerIds/u);
  assert.match(editor, /permission: enabled \? "full"/u);
  assert.match(editor, /mcpServerIds: permission === "read-only" \? \[\]/u);
  assert.match(editor, /Disabled or removed/u);
  assert.match(editor, /MCP tools may read or change external data/u);
});

test("manual edits keep Assistant-owned execution scope locked", () => {
  const editor = source("../components/scheduled-task-editor.tsx");
  const view = source("../components/scheduled-tasks-view.tsx");
  assert.match(editor, /assistantOwned/u);
  assert.match(editor, /Ask Aiden · locked by the approved automation/u);
  assert.match(editor, /disabled=\{assistantOwned\}/u);
  assert.match(editor, /assistantOwned \|\| \(!server\.enabled && !selected\)/u);
  assert.match(editor, /complete final scope can be confirmed again/u);
  assert.match(view, /task\.executionProfile === "assistant"/u);
});

test("Scheduled settings expose an MCP default without hiding exact task scope", () => {
  const settings = source("../components/settings/scheduled-tasks-settings.tsx");
  const view = source("../components/scheduled-tasks-view.tsx");
  const editor = source("../components/scheduled-task-editor.tsx");
  assert.match(settings, /label="Default MCP access"/u);
  assert.match(settings, /defaultMcpEnabled/u);
  assert.match(settings, /defaultPermission: "full"/u);
  assert.match(view, /mcpServers\.filter\(\(server\) => server\.enabled\)/u);
  assert.match(view, /task\.mcpServerIds \?\?/u);
  assert.match(view, /task\.executionProfile === undefined/u);
  assert.match(view, /!task\.workspaceId/u);
  assert.match(view, /const manualCreationUnavailable =/u);
  assert.match(view, /settings\.isLoading/u);
  assert.match(view, /mcpServers\.isLoading/u);
  assert.doesNotMatch(view, /disabled=\{creationUnavailable\}/u);
  assert.ok((view.match(/disabled=\{manualCreationUnavailable\}/gu)?.length ?? 0) >= 2);
  assert.match(view, /const legacyMcpInventoryUnavailable =/u);
  assert.equal(view.match(/disabled=\{legacyMcpInventoryUnavailable\}/gu)?.length, 1);
  assert.match(view, /All enabled MCP servers \(legacy\)/u);
  assert.match(view, /editing is unavailable until access details load/u);
  assert.match(editor, /selectedMcpIds\.length <= 16/u);
  assert.match(editor, /Choose either a workspace or MCP servers/u);
  assert.match(editor, /Choose at most 16 MCP servers/u);
});

test("manual schedule editing preserves explicit Web Search authority", () => {
  const editor = source("../components/scheduled-task-editor.tsx");
  const view = source("../components/scheduled-tasks-view.tsx");
  assert.match(editor, /label="Web Search"/u);
  assert.match(editor, /checked=\{draft\.webSearchEnabled \?\? false\}/u);
  assert.match(editor, /draft\.webSearchEnabled === initial\.webSearchEnabled/u);
  assert.match(view, /webSearchEnabled: task\.webSearchEnabled \?\? false/u);
  assert.match(view, /webSearchEnabled: false/u);
});

test("desktop scheduling keeps natural language and human cadence controls primary", () => {
  const editor = source("../components/scheduled-task-editor.tsx");
  const view = source("../components/scheduled-tasks-view.tsx");
  assert.match(view, /Create with Aiden/u);
  assert.match(view, /Ask Aiden in any chat/u);
  assert.match(view, /formatSchedule\(task\.cron, task\.timezone\)/u);
  assert.match(editor, /title="When should it run\?"/u);
  assert.match(editor, /label="Repeat"/u);
  assert.match(editor, /Advanced schedule/u);
  assert.doesNotMatch(editor, /Five-part cron/u);
});


test("schedule creation requires a final review and retains errors for correction", () => {
  const editor = source("../components/scheduled-task-editor.tsx");
  assert.match(editor, /if \(!reviewing\)/u);
  assert.match(editor, /Review your task/u);
  assert.match(editor, /Edit choices/u);
  assert.match(editor, /Runs without asking you each time/u);
  assert.match(editor, /saveError/u);
  assert.match(editor, /await onSave\(draft\)/u);
});
