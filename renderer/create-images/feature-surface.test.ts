import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("Create Images is a lazy, fail-closed route inside the shared sidebar shell", () => {
  const router = source("../main/router.tsx");
  const sidebar = source("../components/chat-sidebar.tsx");
  const shell = source("../main/chat-layout.tsx");
  const root = source("../main/root-view.tsx");

  assert.match(
    router,
    /React\.lazy\(\(\) =>\s*import\("\.\.\/create-images\/create-images-view"\)/u,
  );
  assert.match(router, /if \(!createImages\) void navigate\(\{ to: "\/", replace: true \}\)/u);
  assert.match(router, /path: "\/create-images"/u);
  assert.match(router, /path: "\/create-images\/\$workflowId"/u);
  assert.match(sidebar, /appCapabilities\.createImages \? \(/u);
  assert.match(sidebar, /title="Create Images"/u);
  assert.match(sidebar, /createImagesMode \? "Search workflows…" : "Search chats…"/u);
  assert.match(sidebar, /<SidebarListGroup title="Image workflows">/u);
  assert.match(sidebar, /useCreateImagesWorkflows/u);
  assert.match(sidebar, /createImagesApi\.create/u);
  assert.doesNotMatch(sidebar, /from "\.\.\/create-images\/fixtures"/u);
  assert.match(
    sidebar,
    /React\.useEffect\(\(\) => \{\s*if \(createImagesMode\) return;\s*const unregister = shortcutAssignments/u,
  );
  assert.match(shell, /createImagesMode \? \(\s*<div[\s\S]*?<Outlet \/>/u);
  assert.match(
    root,
    /<AssistantDock[\s\S]*?environmentPanel\.compactModalOpen \|\| pathname\.startsWith\("\/create-images"\)/u,
  );
  assert.doesNotMatch(root, /pathname\.startsWith\("\/create-images"\) \? null/u);
});

test("the first-open image workspace gate is path-free and exposes recovery controls", () => {
  const queries = source("../lib/queries.ts");
  const view = source("./create-images-view.tsx");
  const styles = source("./create-images.css");
  const handlers = source("../../main/handlers/create-images.ts");
  const service = source("../../main/services/create-images/create-images-service.ts");
  const assets = source("../../main/services/create-images/asset-store-core.ts");

  assert.match(queries, /useCreateImagesWorkspace\(enabled\)/u);
  assert.match(queries, /enabled: enabled && workspace\.data\?\.status === "ready"/u);
  assert.match(view, /CreateImagesWorkspaceSetup/u);
  assert.match(view, /Choose workspace folder/u);
  assert.match(view, /Open in Finder/u);
  assert.match(view, /Sync now/u);
  assert.match(view, /Change workspace folder/u);
  assert.match(view, /createImagesApi\.chooseWorkspace/u);
  assert.match(view, /createImagesApi\.openWorkspace/u);
  assert.match(view, /createImagesApi\.syncWorkspace/u);
  assert.match(view, /displayName/u);
  assert.doesNotMatch(view, /absolutePath|folderPath/u);
  assert.match(styles, /\.create-images-workspace-setup/u);
  assert.match(styles, /\.create-images-workspace-menu-content/u);
  assert.match(styles, /prefers-reduced-motion: reduce/u);
  assert.match(styles, /forced-colors: active/u);
  for (const channel of [
    "imageWorkflows:workspaceStatus",
    "imageWorkflows:chooseWorkspace",
    "imageWorkflows:openWorkspace",
    "imageWorkflows:syncWorkspace",
  ]) {
    assert.ok(handlers.includes(`"${channel}"`), `${channel} must stay main-owned`);
  }
  assert.match(handlers, /parseCreateImagesWorkspaceRequest\(value\)/u);
  assert.match(handlers, /properties: \["openDirectory", "createDirectory"\]/u);
  assert.match(handlers, /shell\.openPath\(target\.filePath\)/u);
  assert.doesNotMatch(handlers, /value\.(?:path|folderPath|absolutePath)/u);
  assert.match(service, /workspaceRequired: true/u);
  assert.match(service, /onAssetPublished:[\s\S]{0,180}syncAsset/u);
  assert.match(assets, /onAssetPublished\?\.\(result\.asset\)/u);
});

test("the Phase 1 editor exposes five typed node kinds and non-spatial controls", () => {
  const canvas = source("./workflow-canvas.tsx");
  const node = source("./workflow-node.tsx");
  const view = source("./create-images-view.tsx");
  const dropCore = source("./image-drop-core.ts");
  const styles = source("./create-images.css");

  for (const type of ["image-input", "prompt", "generate-image", "output", "output-gallery"]) {
    const entry = type.includes("-") ? `"${type}": WorkflowNode` : `${type}: WorkflowNode`;
    assert.ok(canvas.includes(entry), `missing ${type} node renderer`);
  }
  assert.match(canvas, /decideCanvasConnection/u);
  assert.match(canvas, /onlyRenderVisibleElements/u);
  assert.match(canvas, /<MiniMap/u);
  assert.match(canvas, /<ul[\s\S]{0,100}aria-label="Workflow nodes"/u);
  assert.match(canvas, /Add a typed connection/u);
  assert.match(canvas, /aria-label="Workflow connections"/u);
  assert.match(canvas, /aria-live="polite"/u);
  assert.match(canvas, /DialogPrimitive\.Content/u);
  assert.match(canvas, /data-slot="dialog-content"/u);
  assert.doesNotMatch(canvas, /<dialog\s+open/u);
  assert.match(canvas, /createImagesMotionDuration\(300\)/u);
  assert.match(canvas, /CREATE_IMAGES_NODE_WIDTH \* currentZoom/u);
  assert.match(canvas, /nodes: \[\{ id \}\][\s\S]{0,120}maxZoom: 1/u);
  assert.match(canvas, /new ResizeObserver/u);
  assert.match(canvas, /dataset\.appearanceScheme === "dark"/u);
  assert.match(canvas, /colorMode=\{appearanceScheme\}/u);
  assert.match(canvas, /aria-label="Workflow validation issues"/u);
  assert.match(canvas, /onConnectStart=/u);
  assert.match(canvas, /onDragEnter=\{handleCanvasDragEnter\}/u);
  assert.match(canvas, /onDragOver=\{handleCanvasDragOver\}/u);
  assert.match(canvas, /onDrop=\{\(event\) => void handleCanvasDrop\(event\)\}/u);
  assert.match(canvas, /onImportDroppedImages\?: CreateImagesDroppedImageImporter/u);
  assert.match(canvas, /CREATE_IMAGES_ASSET_ID_PATTERN/u);
  assert.match(canvas, /sanitizeCreateImagesImageLabel/u);
  assert.match(dropCore, /reduceCreateImagesDropState/u);
  assert.match(dropCore, /planCreateImagesDrop/u);
  assert.match(dropCore, /type.startsWith\("image\/"\)/u);
  assert.match(styles, /create-images-drop-overlay/u);
  assert.match(styles, /prefers-reduced-motion: reduce/u);
  assert.match(styles, /forced-colors: active/u);
  assert.match(styles, /\.create-images-toolbar span\.create-images-validity/u);
  assert.doesNotMatch(
    styles,
    /\.create-images-toolbar \.create-images-validity\s*\{\s*display: none/u,
  );
  assert.match(canvas, /connectOnClick=\{false\}/u);
  assert.match(canvas, /defaultViewport=\{document\.viewport\}/u);
  assert.match(canvas, /minZoom=\{CREATE_IMAGES_MIN_ZOOM\}/u);
  assert.match(canvas, /maxZoom=\{CREATE_IMAGES_MAX_ZOOM\}/u);
  assert.doesNotMatch(canvas, /\sfitView\s*\n\s*fitViewOptions=/u);
  assert.match(canvas, /Connections must run from an output port to an input port\./u);
  assert.match(canvas, /deletedEdges\.length === 1/u);
  assert.match(canvas, /onBeforeDelete=/u);
  assert.match(
    canvas,
    /edges: current\.edges\.map\(\(edge\) => \(\{ \.\.\.edge, selected: false \}\)\)/u,
  );
  assert.match(canvas, /<span key=\{announcement\.sequence\}>/u);
  assert.match(canvas, /data-create-images-action-status/u);
  assert.match(canvas, /paletteOpen \|\|/u);
  assert.match(canvas, /!workbenchRef\.current\?\.contains\(event\.target\)/u);
  assert.match(canvas, /closest\("#create-images-validation-issues"\)/u);
  assert.match(canvas, /addEventListener\("keydown", onKeyDown, \{ capture: true \}\)/u);
  assert.match(canvas, /miniMapVisible && !narrowCanvas/u);
  assert.match(canvas, /narrowCanvas \? null/u);
  assert.match(view, /<WorkflowCanvas\s+key=\{workflowId\}/u);
  assert.match(
    node,
    /aria-label=\{`\$\{direction === "inputs" \? "Input" : "Output"\}: \$\{port\.label\}`\}/u,
  );
  assert.match(node, /data-create-images-port-label=\{port\.id\}/u);
  assert.match(node, /\{port\.label\}/u);
  assert.match(node, /max-h-40 overflow-y-auto/u);
  assert.match(node, /aria-label=\{`Prompt text · \$\{node\.id\}`\}/u);
  assert.match(node, /aria-label=\{`Choose image for Image Input · \$\{node\.id\}`\}/u);
  assert.match(node, /aria-label=\{`Replace image for Image Input · \$\{node\.id\}`\}/u);
  assert.match(node, /aria-label=\{`Remove image from Image Input · \$\{node\.id\}`\}/u);
  assert.match(node, /restoreAfterChoice/u);
  assert.match(node, /restoreAfterRemove/u);
  assert.match(node, /retainAssetPreview/u);
  assert.match(node, /node\.type === "image-input"[\s\S]{0,180}<ImageInputNode/u);
  assert.match(node, /data-create-images-image-node/u);
  assert.match(node, /className="block size-full object-contain"/u);
  assert.match(node, /create-images-run-output-preview[\s\S]{0,100}object-contain/u);
  assert.match(node, /create-images-gallery-tile[\s\S]{0,900}object-cover/u);
  assert.match(view, /deferAssetPreviewLifecycleDisposal\(previewManager\)/u);
  assert.match(view, /deferAssetPreviewLifecycleDisposal\(runPreviewManager\)/u);
  assert.match(styles, /\.create-images-image-node\s*\{[\s\S]{0,120}background: transparent/u);
  assert.match(styles, /\.create-images-image-node-frame/u);
  assert.match(styles, /\.create-images-image-node-actions/u);
  assert.match(
    node,
    /<div className="group\/image relative overflow-hidden rounded-card bg-well">/u,
  );
  assert.match(node, /className="nodrag nopan nowheel create-images-image-node-actions/u);
  assert.doesNotMatch(
    node,
    /className="nodrag nopan nowheel group\/image relative overflow-hidden/u,
  );
  assert.match(view, /aiden-create-images-recovery-diagnostics/u);
  assert.match(view, /Copy diagnostics/u);
  assert.doesNotMatch(node, /<article/u);
  assert.doesNotMatch(node, /aria-label=\{`\$\{definition\.title\} node`\}/u);
});

test("packaged acceptance observes production network policy and records interaction evidence", () => {
  const main = source("../../main/index.ts");
  const acceptance = source(
    "../../main/services/create-images/packaged-canvas-acceptance-runner.ts",
  );

  assert.match(
    main,
    /import\(\s*"\.\/services\/create-images\/packaged-canvas-acceptance-runner\.js"/u,
  );
  assert.doesNotMatch(main, /CREATE_IMAGES_ACCEPTANCE_FOCUS_/u);
  assert.match(acceptance, /observeCreateImagesRequestPolicy\(\(observation\) =>/u);
  assert.match(
    acceptance,
    /observation\.kind === "renderer-egress"\)[\s\S]*networkRequests \+= 1/u,
  );
  assert.doesNotMatch(acceptance, /webRequest\.onBeforeRequest/u);
  assert.match(acceptance, /assetProtocolAuthorizations === value\.assetProtocolRequests/u);
  assert.match(acceptance, /isAcceptedAssetRequestEvidence\(value\.lastAssetRequest\)/u);
  assert.match(acceptance, /createImagesAcceptanceKeyboardActions \+= 1/u);
  assert.match(acceptance, /CREATE_IMAGES_ACCEPTANCE_FOCUS_FIT_WORKFLOW_SCRIPT/u);
  assert.match(acceptance, /phaseTwoWorkflowRevision: savedWorkflow\.revision/u);
  assert.doesNotMatch(acceptance, /workflowRecord\.revision === 2/u);
  assert.match(acceptance, /securitypolicyviolation/u);
  assert.match(acceptance, /webContents\.on\("console-message", onConsoleMessage\)/u);
  assert.match(acceptance, /const level = event\.level \?\? legacyLevel/u);
  assert.match(acceptance, /const message = event\.message \?\? legacyMessage/u);
  assert.match(acceptance, /webContents\.on\("render-process-gone", onRenderProcessGone\)/u);
  assert.match(acceptance, /getLastWebPreferences\(\)/u);
  assert.match(
    acceptance,
    /readCreateImagesAcceptanceScript<number>\(\s*CREATE_IMAGES_ACCEPTANCE_LIVE_MUTATION_COUNT_SCRIPT/u,
  );
  assert.match(
    acceptance,
    /liveRegionMutations,\s*keyboardActions: createImagesAcceptanceKeyboardActions/u,
  );
  assert.doesNotMatch(acceptance, /liveRegionMutations: 17/u);
  assert.doesNotMatch(acceptance, /keyboardActions: 35/u);
  const runner = source("../../scripts/create-images-packaged-acceptance.mjs");
  assert.match(runner, /waitForChildExitBefore\(childState, deadline\)/u);
  assert.match(runner, /did not exit before the acceptance deadline/u);
  assert.doesNotMatch(runner, /const outcome = await childState\.promise/u);
  const packageJson = source("../../package.json");
  assert.match(packageJson, /verify-create-images-lazy-boundary\.mjs/u);
});

test("Create Images conflicts remain protected across workspace switches and app close", () => {
  const sidebar = source("../components/chat-sidebar.tsx");
  const lifecycle = source("../lib/lifecycle-guard.ts");
  const view = source("./create-images-view.tsx");
  const main = source("../../main/index.ts");

  assert.match(
    sidebar,
    /if \(createImagesMode\) \{\s*const decision = await requestCreateImagesNavigation\(\)/u,
  );
  assert.match(lifecycle, /const owners = new Map/u);
  assert.match(view, /setRendererLifecycleGuard\("create-images", \{ dirty, saving \}\)/u);
  assert.match(view, /clearRendererLifecycleGuard\("create-images"\)/u);
  assert.match(
    main,
    /if \(createImagesFlushAllowed !== true\) \{\s*throw new Error\(\s*"Create Images autosave did not authorize/u,
  );
});

test("advanced proposals and gallery presentation stay inert, bounded, and main-owned", () => {
  const canvas = source("./workflow-canvas.tsx");
  const runUi = source("./run-ui.tsx");
  const rendererIpc = source("../lib/ipc.ts");
  const handlers = source("../../main/handlers/create-images.ts");
  const proposalService = source(
    "../../main/services/create-images/workflow-proposal-service.ts",
  );
  const presentationStore = source(
    "../../main/services/create-images/presentation-store.ts",
  );

  assert.match(canvas, /readModelSelection/u);
  assert.match(canvas, /createImagesApi\.proposeWorkflow/u);
  assert.match(canvas, /commitSnapshot\(\(\) => toCanvasSnapshot\(workflowProposal\.workflow\)\)/u);
  assert.match(canvas, /applying does not contact Gemini or start a run/u);
  assert.match(canvas, /createImagesApi\.getPresentation/u);
  assert.match(canvas, /createImagesApi\s*\.setAssetHidden/u);
  assert.match(runUi, /createImagesSafeRunDiagnosticSummary/u);
  assert.match(runUi, /No prompts, paths, credentials, image bytes, or provider responses/u);
  assert.match(rendererIpc, /imageWorkflows:proposeWorkflow/u);
  assert.match(rendererIpc, /imageWorkflows:getPresentation/u);
  assert.match(rendererIpc, /imageWorkflows:setAssetHidden/u);
  assert.match(handlers, /service\.runs\.isRunAssetReferenced/u);
  assert.match(proposalService, /maxRetries: 0/u);
  assert.doesNotMatch(proposalService, /tools:/u);
  assert.match(presentationStore, /Device-local presentation state/u);
  assert.doesNotMatch(presentationStore, /imageBytes|providerResponse|promptText/u);
});

test("Phase 2 storage stays main-owned, CAS-safe, and path-free across IPC", () => {
  const channels = source("../preload-channels.ts");
  const rendererIpc = source("../lib/ipc.ts");
  const preload = source("../preload.ts");
  const sharedIpc = source("../shared/create-images/ipc.ts");
  const handlers = source("../../main/handlers/create-images.ts");
  const registrations = source("../../main/handlers/index.ts");
  const service = source("../../main/services/create-images/create-images-service.ts");
  const workflowStore = source("../../main/services/create-images/workflow-manifest-store.ts");
  const assetStore = source("../../main/services/create-images/asset-store-core.ts");
  const protocol = source("../../main/services/create-images/asset-protocol.ts");
  const protocolCore = source("../../main/services/create-images/asset-protocol-core.ts");
  const delivery = source("../../main/services/create-images/asset-delivery-core.ts");
  const html = source("../../main-window.html");
  const view = source("./create-images-view.tsx");

  assert.match(channels, /"imageWorkflows:"/u);
  assert.match(registrations, /registerCreateImagesHandlers\(\)/u);
  assert.match(handlers, /if \(!createImagesEnabled\(\)\) return/u);
  assert.match(handlers, /rendererDocumentOwner\(\s*event/u);
  assert.match(handlers, /parseCreateImagesSaveWorkflowRequest/u);
  assert.match(handlers, /randomUUID\(\)/u);
  assert.match(handlers, /service\.mutateWorkflow/u);
  assert.match(rendererIpc, /imageWorkflows:save/u);
  assert.doesNotMatch(sharedIpc, /absolutePath/u);
  assert.match(sharedIpc, /CreateImagesDroppedAssetImportRequest[\s\S]*filePaths/u);
  assert.doesNotMatch(rendererIpc, /importDroppedFiles/u);
  assert.match(preload, /webUtils\.getPathForFile\(file\)/u);
  assert.match(preload, /NATIVE_INVOKE_CHANNELS\.createImagesImportDroppedFiles/u);
  assert.match(handlers, /"aiden:create-images:import-dropped-files"/u);
  assert.match(service, /new WorkflowManifestStore/u);
  assert.match(service, /new ContentAddressedAssetStore/u);
  assert.match(service, /new Set\(\[\.\.\.previous, \.\.\.next\]\)/u);
  assert.match(protocol, /authorizeCreateImagesAssetRequest/u);
  assert.match(protocolCore, /details\.resourceType === "image"/u);
  assert.match(protocol, /authorizeProtocolRequest/u);
  assert.match(delivery, /consumeProtocolRequest/u);
  assert.match(html, /img-src 'self' aiden-asset:/u);
  assert.match(view, /new WorkflowAutosaveController/u);
  assert.match(view, /window\.aidenAPI\.createImages\.importDroppedFiles/u);
  assert.match(view, /previewManager\.adopt\(item\.grant\.asset\.assetId, item\.grant\)/u);
  assert.match(view, /const \[controller\] = React\.useState/u);
  assert.doesNotMatch(view, /new WorkflowAutosaveController\(initial,[\s\S]{0,160}\[initial\]/u);
  assert.match(view, /const \[initialAssetRefs\] = React\.useState/u);
  assert.match(view, /\}, \[initialAssetRefs, previewManager\]\);/u);
  assert.match(view, /registerCreateImagesNavigationGuard/u);
  assert.match(view, /useBlocker\(\{[\s\S]*controller\.flush\(\)/u);
  assert.match(view, /Save a copy/u);
  assert.match(view, /setCanvasEpoch\(\(current\) => current \+ 1\)/u);
  assert.match(view, /Workflow recovery needed/u);
  assert.match(
    view,
    /recovery\.reason === "last-known-good-corrupt" && recovery\.autosave === "none"/u,
  );
  assert.match(view, /previewManager\.reportLoadError/u);
  assert.match(view, /result\.status === "not-found"[\s\S]{0,220}setMissingAssetIds/u);
  assert.match(view, /previewManager\.adopt/u);
  assert.match(
    workflowStore,
    /const created = await fs\.mkdir\(target,[\s\S]{0,260}created !== undefined\)[\s\S]{0,80}syncDirectory\(path\.dirname\(target\)\)/u,
  );
  assert.match(
    assetStore,
    /const created = await fs\.mkdir\(directory,[\s\S]{0,320}created !== undefined\)[\s\S]{0,80}syncDirectory\(path\.dirname\(directory\)\)/u,
  );
});

test("Phase 5 native archives are main-owned, explicit, and available from the workflow library", () => {
  const view = source("./create-images-view.tsx");
  const rendererIpc = source("../lib/ipc.ts");
  const sharedIpc = source("../shared/create-images/ipc.ts");
  const handlers = source("../../main/handlers/create-images.ts");
  const archive = source("../../main/services/create-images/native-archive-service.ts");
  const nodeBanana = source("../../main/services/create-images/node-banana-import-service.ts");
  const notices = source("../../THIRD_PARTY_NOTICES.md");

  assert.match(view, /Import \.aiden-images/u);
  assert.match(view, /Export \.aiden-images/u);
  assert.match(view, /Import Node Banana JSON/u);
  assert.match(view, /Node Banana import report/u);
  assert.match(view, /Review cleanup/u);
  assert.match(view, /Delete unused images/u);
  assert.match(rendererIpc, /imageWorkflows:importArchive/u);
  assert.match(rendererIpc, /imageWorkflows:exportArchive/u);
  assert.match(rendererIpc, /imageWorkflows:importNodeBanana/u);
  assert.match(sharedIpc, /parseCreateImagesImportArchiveRequest/u);
  assert.match(sharedIpc, /parseCreateImagesExportArchiveRequest/u);
  assert.match(sharedIpc, /parseCreateImagesImportNodeBananaRequest/u);
  assert.doesNotMatch(
    sharedIpc,
    /CreateImagesExportArchiveRequest[\s\S]{0,180}(?:path|destination)/u,
  );
  assert.match(handlers, /dialog\.showOpenDialog\(parent,[\s\S]*aiden-images/u);
  assert.match(handlers, /dialog\.showSaveDialog\(parent,[\s\S]*aiden-images/u);
  assert.match(handlers, /shell\.showItemInFolder/u);
  assert.match(handlers, /imageWorkflows:downloadRunAsset/u);
  assert.match(handlers, /imageWorkflows:downloadWorkflowAsset/u);
  assert.match(handlers, /imageWorkflows:listRecentOutputs/u);
  assert.match(handlers, /service\.runs\.listRecentOutputs\(input\.limit\)/u);
  assert.match(
    handlers,
    /service\.references\.isWorkflowAssetReferenced\(input\.workflowId, input\.assetId\)/u,
  );
  assert.match(handlers, /service\.assets\.exportAssetToFile/u);
  assert.match(view, /downloadRunAsset/u);
  assert.match(view, /downloadWorkflowAsset/u);
  assert.match(view, /listRecentOutputs/u);
  assert.match(view, /recentOutputs=/u);
  assert.match(handlers, /CREATE_IMAGES_ASSET_CLEANUP_GRACE_MS/u);
  assert.match(handlers, /planGarbageCollection/u);
  assert.match(handlers, /applyGarbageCollection/u);
  assert.match(archive, /validateCreateImagesArchiveBootstrap/u);
  assert.match(archive, /validateCreateImagesArchiveExtractedEntries/u);
  assert.match(archive, /validateCreateImagesArchiveWorkflowAssets/u);
  assert.match(archive, /validateQuarantinedAssetFile/u);
  assert.match(archive, /origin: \{ kind: "import" \}/u);
  assert.match(nodeBanana, /readRegularFile\(source, CREATE_IMAGES_MAX_WORKFLOW_BYTES\)/u);
  assert.match(nodeBanana, /ingestCreateImagesImageFile/u);
  assert.match(nodeBanana, /parseWorkflowDocument/u);
  assert.doesNotMatch(nodeBanana, /directoryPath|apiKey/u);
  assert.match(notices, /`yauzl@3\.4\.0`/u);
  assert.match(notices, /`yazl@3\.3\.1`/u);
});

test("Phase 3 renderer runs are consented, resubscribed, revision-safe, and run-asset scoped", () => {
  const view = source("./create-images-view.tsx");
  const canvas = source("./workflow-canvas.tsx");
  const node = source("./workflow-node.tsx");
  const adapter = source("./run-ui-adapter.ts");
  const rendererIpc = source("../lib/ipc.ts");
  const channels = source("../preload-channels.ts");

  for (const channel of [
    "startRun",
    "stopRun",
    "listRuns",
    "getRun",
    "recoverRun",
    "resolveRunAmbiguity",
    "subscribeRuns",
    "unsubscribeRuns",
    "grantRunAsset",
    "planRunHistoryPrune",
    "pruneRunHistory",
    "planDegradedRunDiscard",
    "discardDegradedRun",
    "prepareRun",
  ]) {
    assert.match(rendererIpc, new RegExp(`imageWorkflows:${channel}`, "u"));
  }
  assert.match(rendererIpc, /imageWorkflows:run-changed/u);
  assert.match(channels, /"imageWorkflows:run-changed"/u);
  assert.match(view, /runSubscriptionRef\.current\?\.retryNow\(\)/u);
  assert.match(view, /setInterval\(\(\) => runSubscriptionRef\.current\?\.retryNow\(\), 10_000\)/u);
  assert.match(view, /createImagesApi\.getRun\(\{[\s\S]{0,140}runId: visibleRunId/u);
  assert.match(view, /setInterval\(\(\) => void refreshVisibleRun\(\), 5_000\)/u);
  assert.match(
    view,
    /controller\.update\(draft\);[\s\S]{0,200}const flushed = await controller\.saveNow\(\);[\s\S]{0,1200}createImagesApi\.prepareRun/u,
  );
  assert.match(view, /enumerateWorkflowDownstreamPaths\(document, startNodeId\)/u);
  assert.match(view, /scope: undefined,[\s\S]{0,180}downstreamPathChoiceViews/u);
  assert.match(view, /createImagesRunScopeForPathChoice\(/u);
  assert.match(view, /setReviewedRun\(false\)/u);
  assert.match(view, /scope: preparedRun\.scope/u);
  assert.match(view, /executionMode: "gemini"[\s\S]{0,300}consentFingerprint:/u);
  assert.match(view, /createImagesApi\s*\.\s*subscribeRuns/u);
  assert.match(view, /createImagesApi\s*\.\s*unsubscribeRuns/u);
  assert.match(adapter, /notification\.streamSequence > lastStreamSequence/u);
  assert.match(view, /createImagesApi\.getRun/u);
  assert.match(view, /createImagesApi\.recoverRun/u);
  assert.match(
    view,
    /createImagesApi\.resolveRunAmbiguity\(\{[\s\S]{0,260}expectedJournalRevision: run\.journalRevision[\s\S]{0,120}resolution: "acknowledge-unresolved-submission"/u,
  );
  assert.match(view, /result\.status === "resolved"[\s\S]{0,180}applyRunMutation\(result\.run\)/u);
  assert.match(view, /storageHealth\.runIndex\.degradedRecords\.map/u);
  assert.match(view, /record\.discardEligible/u);
  assert.match(view, /record\.association === "unassociated"/u);
  assert.match(
    view,
    /createImagesDegradedRunDiscardRequest\(plan, reviewed\)[\s\S]{0,200}createImagesApi\.discardDegradedRun\(request\)/u,
  );
  assert.match(
    view,
    /result\.status === "conflict"[\s\S]{0,120}setPlan\(undefined\)[\s\S]{0,220}fresh discard summary/u,
  );
  assert.match(view, /removeCreateImagesRunRecord\(runStateRef\.current, result\.runId\)/u);
  assert.match(view, /runHistoryRequestSequence\.current \+= 1/u);
  assert.doesNotMatch(view, /result\.authoritativeList/u);
  assert.doesNotMatch(view, /createImagesApi\.listRuns/u);
  assert.match(view, /result\.status === "conflict"[\s\S]{0,240}closed = true/u);
  assert.match(canvas, /!runProjection\.ambiguityAcknowledged/u);
  assert.match(view, /source: recovery\.recoverySource/u);
  assert.match(view, /expectedCandidateJournalRevision/u);
  assert.match(view, /isCreateImagesRunRecoveryRequestCurrent\(/u);
  assert.match(view, /isCreateImagesRunHistoryRequestCurrent\(/u);
  assert.match(view, /isCreateImagesRunAmbiguityRequestCurrent\(/u);
  assert.match(view, /createImagesSelectedRunSnapshotTransition\(/u);
  assert.match(
    view,
    /transition\.kind === "recovery-changed"[\s\S]{0,120}runHistoryRequestSequence\.current \+= 1/u,
  );
  assert.match(
    view,
    /transition\.kind === "removed" \|\| transition\.kind === "became-healthy"[\s\S]{0,120}runHistoryRequestSequence\.current \+= 1/u,
  );
  assert.doesNotMatch(view, /if \(selectedRunId\) \{\s*runHistoryRequestSequence\.current \+= 1/u);
  assert.match(view, /if \(!responseIsCurrent\(\)\) return;/u);
  assert.match(
    view,
    /runHistoryLifecycleRef\.current = \{ mounted: false, generation: generation \+ 1 \}[\s\S]{0,120}runHistoryRequestSequence\.current \+= 1[\s\S]{0,100}selectedHistoryRunIdRef\.current = undefined/u,
  );
  assert.match(
    view,
    /isCreateImagesRunHistoryRequestCurrent\([\s\S]{0,700}trigger\.isConnected[\s\S]{0,100}trigger\.focus\(\)/u,
  );
  assert.match(view, /!applyRunMutation\(result\.run\)/u);
  assert.match(view, /if \(!mountedRef\.current\) return;/u);
  assert.match(view, /createImagesRunSubscriptionController/u);
  assert.match(view, /window\.addEventListener\("focus", retryWhenFocused\)/u);
  assert.match(view, /visibilityState === "visible"/u);
  assert.match(adapter, /retryDelaysMs \?\? DEFAULT_SUBSCRIPTION_RETRY_DELAYS_MS/u);
  assert.match(adapter, /MAX_PENDING_SUBSCRIPTIONS/u);
  assert.match(adapter, /pendingSnapshot\.streamSequence > lastStreamSequence/u);
  assert.match(adapter, /removeNotificationListener\?\.\(\)/u);
  assert.match(view, /new AssetPreviewLifecycleManager\(\{[\s\S]*?grantRunAsset/u);
  assert.match(view, /deferAssetPreviewLifecycleDisposal\(runPreviewManager\)/u);
  assert.match(canvas, /planWorkflowExecution\(currentDocument, runFromHereScope\)/u);
  assert.match(canvas, /runAllDisabledReason[\s\S]{0,500}graphIssues\[0\]\?\.message/u);
  assert.match(canvas, /runFromHereDisabledReason/u);
  assert.match(canvas, /CreateImagesRunProgressPanel/u);
  assert.match(canvas, /CreateImagesTerminalRunHistory/u);
  assert.match(node, /CreateImagesNodeRunStatusBadge/u);
  assert.match(node, /retainRunAssetPreview/u);
  assert.match(adapter, /nextProjection\.lastSequence < oldProjection\.lastSequence/u);
  assert.match(view, /reconcileCreateImagesRunMutation\(previous, run, initial\.id\)/u);
  assert.doesNotMatch(view, /applyRunList\(/u);
  assert.match(view, /apply: applyRunList/u);
  assert.doesNotMatch(view, /activeRun: run,\s*history: \[\],\s*recoveries: \[\]/u);
  assert.match(adapter, /result\.recoveries\.filter/u);
  assert.match(adapter, /recoveryRunIds\.has\(previous\.projection\.runId\)/u);
  assert.match(adapter, /createImagesRunAssetOwners\(latestTerminalRun\)/u);
  assert.match(adapter, /previous\.history\.filter\(\(item\) => item\.runId !== runId\)/u);
  assert.match(view, /selectedHistoryRunIdRef\.current = undefined/u);
  assert.doesNotMatch(
    view,
    /selectHistoryRun[\s\S]{0,1600}requestAnimationFrame\(\(\) => trigger\.focus\(\)\)/u,
  );
  assert.match(view, /across all Create Images workflows/u);
  assert.match(view, /may include imported inputs and generated outputs/u);
  assert.match(
    view,
    /released file[\s\S]{0,160}with no other\s+workflow or run reference may later be removed/u,
  );
  assert.match(view, /storageHealth\.runIndex\.status !== "healthy"/u);
  assert.match(view, /Run history index recovered/u);
  assert.match(node, /key=\{`\$\{assetId\}:\$\{index\}`\}/u);
});

test("Create Images settings expose bounded autosave and canvas preferences", () => {
  const settings = source("../components/settings/create-images-settings.tsx");
  const settingsView = source("../main/settings-view.tsx");
  const settingsSections = source("../shared/settings-section.ts");
  const canvas = source("./workflow-canvas.tsx");
  const view = source("./create-images-view.tsx");

  assert.match(settingsSections, /id: "createImages"[\s\S]{0,100}title: "Create Images"/u);
  assert.match(settingsView, /createImages: CreateImagesSettings/u);
  assert.match(settings, /Autosave workflows/u);
  assert.match(settings, /Manual save is on/u);
  assert.match(settings, /Power features/u);
  assert.match(settings, /Canvas navigation/u);
  assert.match(view, /autosaveEnabled=\{autosaveEnabled\}/u);
  assert.match(view, /onSaveWorkflow=\{\(\) => void saveWorkflow\(\)\}/u);
  assert.match(canvas, /if \(!canvasEditInProgress\) onDocumentChange\?\.\(currentDocument\)/u);
  assert.match(canvas, /nodeEditStartSnapshot\.current\?\.nodeId !== nodeId/u);
  assert.match(canvas, /setCanvasEditInProgress\(true\)/u);
});
