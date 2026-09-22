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
  assert.match(sidebar, /title=\{createBusy \? "Creating…" : "New Project"\}/u);
  assert.match(sidebar, /title="Profile"/u);
  assert.match(sidebar, /title="Settings"/u);
  assert.match(library, /label: "All"/u);
  assert.match(library, /label: "Prototype"/u);
  assert.match(library, /label: "Connected"/u);
});

test("new projects start local and do not ask for workspace or Git authority", () => {
  assert.match(sidebar, /designerApi\.createProject\(\)/u);
  assert.doesNotMatch(sidebar, /connectedWorkspaceId|design-project-origin|App workspace/u);
  assert.doesNotMatch(sidebar, /title="New Design Project"|createOpen/u);
  assert.match(sidebar, /title="Rename Design Project"/u);
});

test("Design project state remains available on the index and active-project routes", () => {
  assert.match(sidebar, /activeProjectId=\{activeProjectId\}/u);
  assert.match(sidebar, /designerApi\.listProjects\(\)/u);
  assert.match(sidebar, /loading=\{loading\}/u);
  assert.match(sidebar, /error=\{error\}/u);
  assert.match(sidebar, /onRetry=\{\(\) => void refresh\(\)\}/u);
  assert.match(layout, /activeProjectId=\{designProjectIdFromPath\(pathname\)\}/u);
});

test("repair is an explicit bounded recovery flow with a truthful regenerate fallback", () => {
  assert.match(sidebar, /designerApi\.inspectArtifactRecovery\(projectId\)/u);
  assert.match(sidebar, /designerApi\.recoverArtifact/u);
  assert.match(sidebar, /Recover as new revision/u);
  assert.match(sidebar, /Remove missing history entry/u);
  assert.match(sidebar, /Unavailable Design history entry removed/u);
  assert.match(sidebar, /Open to regenerate/u);
  assert.match(sidebar, /project\?\.recoveryAction === "open-project"/u);
  assert.match(sidebar, /void inspectRecovery\(id\)/u);
  assert.doesNotMatch(sidebar, /onRepairProject=\{\(\) => void refresh\(\)\}/u);
  assert.match(
    sidebar,
    /project snapshot intentionally omits health[\s\S]*designerApi[\s\S]*\.listProjects\(\)/u,
  );
  assert.match(
    sidebar,
    /result\.status === "regenerate"[\s\S]*result\.project[\s\S]*onProjectChange\(result\.project\)[\s\S]*setRecoveryPlan\(undefined\)[\s\S]*if \(!\(await refresh\(\)\)\)[\s\S]*return;[\s\S]*setRecoveryPlan\(result\.plan\)/u,
    "repairing the already-open project applies its removed-artboard snapshot before regeneration",
  );
  assert.match(
    sidebar,
    /setError\([\s\S]*return false;[\s\S]*The repair finished, but the project list could not be refreshed/u,
    "a failed authoritative refresh blocks the regenerate plan and exposes a retryable error",
  );
  assert.match(sidebar, /useQueryClient\(\)/u);
  assert.match(
    sidebar,
    /result\.status === "recovered"[\s\S]*invalidateQueries\(\{ queryKey: queryKeys\.chat\(project\.chatId\) \}\)[\s\S]*toast\.success/u,
    "recovery refreshes the exact conversation before reporting success to the active canvas",
  );
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

test("route changes select their sidebar before paint and preserve newer project revisions", () => {
  assert.match(layout, /React\.useLayoutEffect\(\(\) => \{\s*const routeMode/u);
  assert.match(layout, /const latestProjectRef = React\.useRef/u);
  assert.match(
    layout,
    /projectUpdate\?\.id !== projectOrLegacyChatId &&[\s\S]*projectUpdate\?\.chatId !== projectOrLegacyChatId/u,
  );
  assert.match(layout, /const opened = openResult\.project/u);
  assert.match(
    layout,
    /latest\?\.id === opened\.id && latest\.revision > opened\.revision[\s\S]*setProject\(latest\)/u,
  );
  assert.match(
    layout,
    /setDesignPublication\(openResult\.designPublication\)[\s\S]*openedRouteIdentity !== projectOrLegacyChatId/u,
  );
  assert.match(layout, /designPublication=\{designPublication\}/u);
  assert.match(
    layout,
    /onDesignPublicationResolved=\{\(\) => setDesignPublication\(undefined\)\}/u,
  );
  assert.match(sidebar, /const project = openResult\.project/u);
  assert.match(
    sidebar,
    /openResult\.designPublication === "retryable"[\s\S]*Reopen this project to retry recovery/u,
  );
});

test("a rejected mode change keeps the compact sidebar open", () => {
  const switcher = readFileSync(new URL("./workspace-mode-switcher.tsx", import.meta.url), "utf8");
  assert.match(switcher, /if \(onModeChange\(nextMode\)\) closeIfCompact\(\)/u);
  assert.match(layout, /if \(nextMode === mode\) return false/u);
  assert.match(layout, /toast\.info\(blockedReason\);\s*return false/u);
});
