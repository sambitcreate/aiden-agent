import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const canvas = readFileSync(new URL("./design-workspace.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../main/chat-layout.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./design-project-sidebar.tsx", import.meta.url), "utf8");
const pane = readFileSync(new URL("../main/chat-pane.tsx", import.meta.url), "utf8");
const handlers = readFileSync(new URL("../../main/handlers/designer.ts", import.meta.url), "utf8");
const chatHandlers = readFileSync(new URL("../../main/handlers/chats.ts", import.meta.url), "utf8");
const llmClient = readFileSync(
  new URL("../../main/services/llm-client.ts", import.meta.url),
  "utf8",
);
const main = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const recovery = readFileSync(new URL("./design-handoff-recovery.tsx", import.meta.url), "utf8");
const directEditService = readFileSync(
  new URL("../../main/services/design-direct-edit-service.ts", import.meta.url),
  "utf8",
);

test("Design routes migrate legacy chats and open projects by durable identity", () => {
  assert.match(layout, /designerApi[\s\S]*?\.openProject\(projectOrLegacyChatId\)/u);
  assert.match(layout, /opened\.id !== projectOrLegacyChatId/u);
  assert.match(layout, /designProject=\{project\}/u);
  assert.match(sidebar, /designerApi\.listProjects\(\)/u);
});

test("Design Project creation is always local-first while connection remains a later action", () => {
  assert.match(sidebar, /designerApi\.createProject\(\{[\s\S]*connectionState: "prototype-only"/u);
  assert.doesNotMatch(sidebar, /design-project-origin|connectedWorkspaceId|Connect a local app/u);
  assert.match(sidebar, /Connect a workspace or Git repository later from the project/u);
  assert.match(canvas, /designerApi\.connectProject/u);
});

test("Design generation consumes a main-owned preflight receipt before durable append", () => {
  const preflightIndex = pane.indexOf("designerApi.preflightGeneration");
  const appendIndex = pane.indexOf("chatsApi.appendMessage", preflightIndex);
  assert.ok(preflightIndex >= 0);
  assert.ok(appendIndex > preflightIndex);
  assert.match(pane, /preflight\.projectId !== persistedProject\.id/u);
  assert.match(pane, /preparedWorkspaceId = preflight\.workspaceId/u);
  assert.match(pane, /runGeneration\(messageTurnId, preparedWorkspaceId\)/u);
});

test("canvas persists layout and active selection without inferring generated ownership", () => {
  assert.match(canvas, /project\.canvas\.flowViewport/u);
  assert.match(canvas, /instance\.setViewport\(savedProject\.canvas\.flowViewport\)/u);
  assert.match(canvas, /onMoveEnd=/u);
  assert.match(canvas, /designerApi\.updateProject/u);
  assert.match(canvas, /expectedRevision: currentProject\.revision/u);
  assert.match(canvas, /if \(prior\?\.kind !== "artboard"\) continue/u);
  assert.match(canvas, /\.\.\.prior,[\s\S]*prior\.artifactMediaIds\?\.includes/u);
  assert.doesNotMatch(canvas, /lineage:\$\{data\.group\.revisions\[0\]!\.artifact\.id\}/u);
  assert.match(canvas, /setTimeout\(\(\) => \{[\s\S]*void flushProjectPersistence\(\)\.catch/u);
  assert.match(canvas, /result\.status === "conflict"/u);
  assert.match(pane, /designerApi\s*\.openProject\(\s*currentDesignProject\.id,?\s*\)/u);
  assert.match(pane, /updateDesignProject\(publishedProject\)/u);
  assert.match(pane, /project=\{currentDesignProject\}/u);
  assert.match(canvas, /onPersistenceBarrierChange\?\.\(flushProjectPersistence\)/u);
  assert.match(
    canvas,
    /activeVersionsRef\.current\[node\.id\] \?\? data\.artifact\.mediaId/u,
    "same-tick persistence reads the selected historical revision synchronously",
  );
  assert.match(
    canvas,
    /const targetSnapshot = snapshotDesignTurnTargets\(targetsRef\.current\);[\s\S]*persistenceBarrierRef\.current\.flush/u,
    "the send barrier captures H synchronously before waiting for an older save",
  );
  assert.match(
    canvas,
    /const nextTargets = targetsRef\.current\.map[\s\S]*publishTargets\(nextTargets\)/u,
    "selecting historical H updates the synchronous target authority",
  );
  const flushIndex = pane.indexOf("await persistenceBarrier()");
  const preflightIndex = pane.indexOf("designerApi.preflightGeneration", flushIndex);
  assert.ok(flushIndex >= 0, "Design send awaits the canvas persistence barrier");
  assert.ok(preflightIndex > flushIndex, "main preflight follows the durable canvas save");
  assert.match(
    pane,
    /const persistedProject = persistenceSnapshot\.project;\s+selectedTargets = persistenceSnapshot\.targets;/u,
    "Design context uses the barrier's exact H target instead of the stale React N target",
  );
  assert.doesNotMatch(pane, /selectedTargets = design \? \[\.\.\.designTargets\]/u);
  assert.match(pane, /preflight\.projectRevision !== persistedProject\.revision/u);
  assert.doesNotMatch(canvas, /projectRevision: savedProject\?\.revision/u);
  assert.match(
    canvas,
    /data\.artifact\.id, data\.artifact\.mediaId, data\.chatId/u,
    "preview reloads only when immutable artifact identity changes",
  );
  assert.doesNotMatch(
    canvas,
    /data\.artifact\.mediaId, data\.chatId, data\.projectRevision/u,
    "layout-only project revisions must not remount interactive previews",
  );
});

test("detached optimistic previews explicitly resume and suspend exact main-owned authority", () => {
  assert.match(
    pane,
    /chatsApi\s*\.resumeDetachedDesignPreview\(visibleDetachedStreamId, chatId\)/u,
  );
  assert.match(pane, /chatsApi\.suspendDetachedDesignPreview\(visibleDetachedStreamId\)/u);
  assert.match(
    pane,
    /resumedDetachedDesignPreviewStreamId === visibleDetachedStreamId[\s\S]*\? visibleDetachedStreamId/u,
  );
  assert.match(chatHandlers, /llmClient\.resumeDetachedDesignPreview/u);
  assert.match(llmClient, /runtime\.owner\.documentId !== ownerDocumentId/u);
  assert.match(llmClient, /runtime\.chatId !== chatId/u);
  assert.match(llmClient, /designLivePreviewAuthority\.suspendStream/u);
  assert.match(
    llmClient,
    /if \(params\.design === true\) \{\s+designLivePreviewAuthority\.admitStream/u,
    "Design admission creates an empty authority record before the first artifact",
  );
});

test("terminal Design output remains optimistic behind actionable reconciliation until claimed", () => {
  assert.match(
    pane,
    /designProjectClaimsArtifacts\(publishedProject, optimisticDesignArtifacts\)/u,
  );
  assert.match(
    pane,
    /setDesignProjectReconciliation\(\{[\s\S]*artifacts: optimisticDesignArtifacts/u,
  );
  assert.match(pane, /designProjectReconciliation\?\.artifacts \?\? \[\]/u);
  assert.match(pane, /retryDesignProjectReconciliation/u);
  assert.match(pane, /if \(chatIdRef\.current !== chatId\) return;/u);
  assert.match(canvas, /<ProjectReconciliationNotice/u);
  assert.match(canvas, /The generated preview remains available while you retry/u);
  assert.match(canvas, /aria-label="Design history reconciliation"/u);
});

test("durable publication migrates provisional artboard positions through immutable media identity", () => {
  assert.match(canvas, /const positionsByMediaId = new Map/u);
  assert.match(canvas, /positionsByMediaId\.set\(revision\.artifact\.mediaId, node\.position\)/u);
  assert.match(canvas, /position: resolveDesignArtboardPosition\(\{/u);
  assert.match(
    canvas,
    /fallback: savedPositions\.get\(group\.id\) \?\? \{\s+x: sourceOffset \+ index \* \(VIEWPORT_SIZE\[viewport\]\.width \+ 120\)/u,
  );
});

test("project connection and local preview are separate, state-appropriate actions", () => {
  assert.match(canvas, /"Connect app…"/u);
  assert.match(canvas, /"Reconnect app…"/u);
  assert.match(canvas, /"Start local preview"/u);
  assert.match(canvas, /"Local preview"/u);
  assert.match(canvas, /savedProject\?\.connectionState === "prototype-only"/u);
  assert.match(canvas, /designerApi\.connectProject/u);
  assert.match(canvas, /Generated HTML, CSS, and JavaScript stay in Aiden/u);
  assert.doesNotMatch(canvas, /running \? "Local app" : "Connect app"/u);
});

test("reference images are content-addressed in main and hydrated before canvas writes", () => {
  assert.match(canvas, /designerApi\.putReferenceAsset/u);
  assert.match(canvas, /designerApi\.readReferenceAsset/u);
  assert.match(canvas, /assetIdByNodeRef/u);
  assert.match(canvas, /if \(!savedProject \|\| !assetsHydrated\) return/u);
  assert.match(canvas, /designerApi\.removeMissingReferenceAsset/u);
  assert.match(handlers, /designer:removeMissingReferenceAsset/u);
  assert.match(canvas, /MissingReferenceRepairNotice/u);
});

test("startup removes only reference assets unowned after lifecycle recovery", () => {
  const recovery = main.indexOf("await designProjectLifecycle.recover()");
  const prune = main.indexOf("pruneUnreferencedDesignAssetsAtStartup", recovery);
  const rendererRegistration = main.indexOf("registerGenerativeUiProtocol()", prune);
  assert.ok(recovery >= 0 && prune > recovery && rendererRegistration > prune);
  assert.match(main, /projects: designProjectStore/u);
});

test("project inspector reads only project-owned generated revisions and exports through main", () => {
  assert.match(canvas, /designerApi\.readGeneratedSource/u);
  assert.match(canvas, /<DesignProjectInspector/u);
  assert.match(canvas, /designerApi[\s\S]*?\.exportProjectBundle/u);
  assert.match(canvas, /second\s+executable document/u);
  assert.match(canvas, /for \(const mediaId of mediaIds\)/u);
  assert.match(canvas, /setGeneratedSourceErrors\(\(current\) => \(\{/u);
  assert.match(canvas, /generatedSourceErrors\[selectedMediaId\]/u);
  assert.doesNotMatch(
    canvas,
    /Promise\.all\(\s*selectedGroup\.revisions[\s\S]*?readGeneratedSource/u,
  );
});

test("persistent comments are initialized in main and remain project and immutable-revision scoped", () => {
  assert.match(main, /await designCommentStore\.initialize\(\)/u);
  assert.match(handlers, /designer:listComments/u);
  assert.match(handlers, /designer:createComment/u);
  assert.match(handlers, /requireOwnedCommentTarget/u);
  assert.match(handlers, /committedRecoverySourceFor/u);
  assert.match(handlers, /isUsablePublishedDesignSource\(project, source\)/u);
  assert.match(handlers, /artifactId !== target\.source\.artifactId/u);
  assert.match(canvas, /<DesignCommentsPanel/u);
  assert.match(canvas, /expectedDatabaseRevision: currentView\.databaseRevision/u);
});

test("attached design systems are explicit, freshness proven, and preview exact model context", () => {
  assert.match(main, /await designSystemSnapshotStore\.initialize\(\)/u);
  assert.match(handlers, /designer:attachDesignSystem/u);
  assert.match(handlers, /designer:refreshDesignSystem/u);
  assert.match(handlers, /designer:detachDesignSystem/u);
  assert.match(handlers, /designer:designSystemModelContext/u);
  assert.match(canvas, /Exactly what Aiden sends with an accepted Design turn/u);
  assert.match(canvas, /does not run package code/u);
  assert.match(canvas, /designerApi\.designSystemModelContext/u);
});

test("recoverable handoffs stay project-visible with only semantically valid operations", () => {
  assert.match(handlers, /designer:projectHandoffRecoveries/u);
  assert.match(canvas, /designerApi\.projectHandoffRecoveries\(projectId\)/u);
  assert.match(canvas, /<DesignHandoffRecoveryPanel/u);
  assert.match(recovery, /record\.canResume/u);
  assert.match(recovery, /record\.canCancel/u);
  assert.match(recovery, /record\.linkage/u);
  assert.match(recovery, /\n\s+Resume\n/u);
  assert.match(recovery, /\n\s+Open <ArrowRight/u);
  assert.match(recovery, /<X aria-hidden="true" \/> Cancel/u);
  assert.match(recovery, /role="alert"/u);
  assert.match(recovery, /role="status"/u);
});

test("prototype direct-edit Undo is a native one-step control with compact and contrast-safe states", () => {
  assert.match(handlers, /designer:undoPrototypeDirectEdit/u);
  assert.match(directEditService, /direct-edit-revert/u);
  assert.match(directEditService, /publishGeneratedRevisions/u);
  assert.match(directEditService, /revisionOfMediaId: input\.editedMediaId/u);
  assert.match(main, /record\.generationId\.startsWith\("direct-edit-revert:"\)/u);
  assert.match(canvas, /designerApi\.undoPrototypeDirectEdit/u);
  assert.match(canvas, /DesignPrototypeDirectEditRetryState/u);
  assert.match(canvas, /operationId,[\s\S]*\.\.\.prototypeDirectEditPayload/u);
  const invoke = canvas.indexOf("designerApi.applyPrototypeDirectEdit");
  const complete = canvas.indexOf("prototypeDirectEditRetryRef.current.complete", invoke);
  const restoreUndo = canvas.indexOf("setPrototypeDirectEditUndo", complete);
  assert.ok(invoke >= 0 && complete > invoke && restoreUndo > complete);
  assert.match(
    handlers,
    /new Set\(\[\s*"operationId",\s*"projectId",\s*"lineageId",\s*"mediaId",\s*"selection",\s*"edit",?\s*\]\)/u,
  );
  assert.match(handlers, /parseRendererPrototypeGestureId\(input\.operationId\)/u);
  assert.doesNotMatch(
    handlers.slice(
      handlers.indexOf('ipcMain.handle("designer:applyPrototypeDirectEdit"'),
      handlers.indexOf('ipcMain.handle("designer:undoPrototypeDirectEdit"'),
    ),
    /candidate\.activeMediaId === mediaId/u,
  );
  assert.match(canvas, /onClick=\{\(\) => void undoPrototypeDirectEdit\(\)\}/u);
  assert.match(canvas, /Undo direct edit as a new exact-revert revision/u);
  assert.match(canvas, /role="status"/u);
  assert.match(styles, /\.design-direct-edit-undo/u);
  assert.match(styles, /:root\[data-reduce-motion="true"\][\s\S]*\.design-direct-edit-undo/u);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.design-direct-edit-undo/u);
  assert.match(
    styles,
    /@media \(forced-colors: active\)[\s\S]*\.design-handoff-recovery button:focus-visible/u,
  );
});

test("connected direct edits retain one strict operation identity through durable acknowledgement", () => {
  assert.match(canvas, /DesignConnectedDirectEditRetryState/u);
  assert.match(canvas, /connectedDirectEditRetryRef\.current\.operationIdFor/u);
  assert.match(canvas, /operationId,[\s\S]*\.\.\.connectedDirectEditPayload/u);
  assert.match(canvas, /connectedDirectEditRetryRef\.current\.complete\(operationId\)/u);
  assert.match(handlers, /new Set\(\["operationId", "projectId", "sourceSelectionId", "edit"\]\)/u);
  assert.match(handlers, /parseRendererDirectEditGestureId\(input\.operationId\)/u);
  assert.match(directEditService, /actionId: `action_\$\{digest\(proposal\.proposalId\)\}`/u);
});

test("a saved prototype edit remains successful when ancillary source hydration needs retry", () => {
  assert.match(canvas, /const sourceHydrated = await hydrateGeneratedSource/u);
  assert.match(canvas, /Direct edit saved\. Reload the Code view to read its source\./u);
  assert.match(canvas, /Undo saved\. Reload the Code view to read its source\./u);
  assert.match(canvas, /generatedSourceErrors\[selectedMediaId\]/u);
  assert.match(canvas, /onRetrySource=/u);
});
