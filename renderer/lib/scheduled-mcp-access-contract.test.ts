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

test("Scheduled settings expose an MCP default without hiding exact task scope", () => {
  const settings = source("../components/settings/scheduled-tasks-settings.tsx");
  const view = source("../components/scheduled-tasks-view.tsx");
  assert.match(settings, /label="Default MCP access"/u);
  assert.match(settings, /defaultMcpEnabled/u);
  assert.match(settings, /defaultPermission: "full"/u);
  assert.match(view, /mcpServers\.filter\(\(server\) => server\.enabled\)/u);
  assert.match(view, /task\.mcpServerIds \?\?/u);
  assert.match(view, /task\.executionProfile === undefined/u);
});
