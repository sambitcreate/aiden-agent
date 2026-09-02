import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebar = readFileSync(new URL("./design-project-sidebar.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../main/chat-layout.tsx", import.meta.url), "utf8");
const library = readFileSync(new URL("./design-project-library.tsx", import.meta.url), "utf8");

test("Design replaces the Agent sidebar with its own complete project navigation", () => {
  assert.match(layout, /mode === "design" \? \([\s\S]*<DesignProjectSidebar/u);
  assert.match(layout, /\) : \([\s\S]*<ChatSidebar/u);
  assert.match(sidebar, /searchPlaceholder="Search projects…"/u);
  assert.match(sidebar, /title="New Project"/u);
  assert.match(sidebar, /title="Profile"/u);
  assert.match(sidebar, /title="Settings"/u);
  assert.match(library, /label: "All"/u);
  assert.match(library, /label: "Prototype"/u);
  assert.match(library, /label: "Connected"/u);
});

test("new projects start local and do not ask for workspace or Git authority", () => {
  assert.match(
    sidebar,
    /designerApi\.createProject\(\{[\s\S]*title: nextTitle,[\s\S]*connectionState: "prototype-only"/u,
  );
  assert.doesNotMatch(sidebar, /connectedWorkspaceId|design-project-origin|App workspace/u);
  assert.match(sidebar, /Connect a workspace or Git repository later from the project/u);
});

test("Design project state remains available on the index and active-project routes", () => {
  assert.match(sidebar, /activeProjectId=\{activeProjectId\}/u);
  assert.match(sidebar, /designerApi\.listProjects\(\)/u);
  assert.match(sidebar, /loading=\{loading\}/u);
  assert.match(sidebar, /error=\{error\}/u);
  assert.match(sidebar, /onRetry=\{\(\) => void refresh\(\)\}/u);
  assert.match(layout, /activeProjectId=\{designProjectIdFromPath\(pathname\)\}/u);
});

test("sidebar mutations keep the active project authoritative and clear deleted restore targets", () => {
  assert.match(
    sidebar,
    /onProjectChange\(result\.status === "updated" \? result\.project : result\.current\)/u,
  );
  assert.match(sidebar, /onProjectUnavailable\(deletePlan\.projectId\)/u);
  assert.match(layout, /designProjectOverride/u);
  assert.match(layout, /onProjectChange: setDesignProjectUpdate/u);
  assert.match(layout, /onProjectUnavailable: handleDesignProjectUnavailable/u);
});

test("compact navigation closes the modal sidebar before revealing its destination", () => {
  assert.match(sidebar, /useSplitViewSidebar\(\)/u);
  assert.match(sidebar, /const openProject[\s\S]*closeIfCompact\(\)[\s\S]*navigate/u);
  assert.match(sidebar, /title="Profile"[\s\S]*closeIfCompact\(\)/u);
  assert.match(sidebar, /title="Settings"[\s\S]*closeIfCompact\(\)/u);
});
