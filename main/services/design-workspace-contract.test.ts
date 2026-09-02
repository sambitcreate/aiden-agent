import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Design turns retain the model backend but use a positive tool and extension allowlist", () => {
  const source = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const extension = readFileSync(new URL("./generative-ui-extension.ts", import.meta.url), "utf8");
  assert.match(source, /const designWorkspace = params\.design === true/u);
  assert.match(source, /designProjectStore\.getByChatId\(params\.chatId\)/u);
  assert.match(source, /authoritativeDesignGenerationWorkspaceId/u);
  assert.match(source, /const authoritativeDesign = authoritativeChatDesignMode\(/u);
  assert.match(
    source,
    /authoritativeDesign\s*\? persistedChatWorkspaceId\(chat\.workspaceId\)\s*:\s*authoritativeChatWorkspaceId/u,
  );
  assert.match(source, /workspaceId: generationWorkspaceId/u);
  assert.match(source, /designProject\?\.connectionState === "prototype-only"/u);
  assert.match(source, /!assistantPersonaMode && !repositoryFreeDesign/u);
  assert.match(source, /Design workspace is unavailable for this conversation/u);
  assert.match(source, /shouldEnableDesignWorkspace/u);
  assert.match(source, /botBound: botContext !== undefined/u);
  assert.match(source, /project: designProject/u);
  assert.match(source, /workspaceId: workspace\?\.id/u);
  assert.match(
    source,
    /designWorkspace\s*\? designWorkspaceEnabled\s*:\s*!botContext &&\s*shouldEnableGenerativeUiExtension/u,
  );
  assert.match(source, /permission,\s*excluded:/u);
  assert.match(source, /if \(designWorkspace\) return \[\];\s*return buildAgentTools\(context\)/u);
  assert.match(
    source,
    /await buildNonDesignAgentTools\(designWorkspace, \{/u,
  );
  assert.match(
    source,
    /const git =\s*!designWorkspace && folderPath/u,
    "Design must not construct ambient tools or inspect Git before applying its positive adapter allowlist",
  );
  assert.match(
    source,
    /params\.design === true\s*\? generationExtensions\s*:\s*\[\s*\.\.\.runtimeExtensionSnapshot\.extensions/u,
  );
  assert.match(source, /!designWorkspace &&\s*options\.allowComputerUse/u);
  assert.match(source, /!designWorkspace &&\s*!botContext &&\s*shouldEnableDisplayImageExtension/u);
  assert.match(source, /designWorkspaceThisTurn: designWorkspace/u);
  assert.match(source, /generativeUiArtifactStore\.committedRecoverySourceFor/u);
  assert.match(source, /latestActiveDesignArtifact\(chat, designProject\)/u);
  assert.match(source, /projectOwnsDesignMedia\(designProject, target\.mediaId\)/u);
  assert.match(
    source,
    /requireCommittedDesignContextHtml\(item\.artifact, source, designProject\)/u,
  );
  assert.match(source, /artifact\.mediaId === target\.mediaId/u);
  assert.match(source, /artifact\.id === target\.artifactId/u);
  assert.match(source, /selected Design canvas item is stale/u);
  assert.match(source, /selectedTargets\.length === 1 && designProject/u);
  assert.match(source, /candidate\.artifactMediaIds\?\.includes\(selected\.mediaId\)/u);
  assert.match(
    source,
    /durableArtifact = \{ \.\.\.artifact, revisionOfMediaId: designRevisionAnchor \}/u,
  );
  assert.match(source, /await designProjectStore\.get\(designProject\.id\)/u);
  assert.match(source, /priorDesigns/u);
  assert.match(extension, /omitHistoricalDesignHtml/u);
});

test("legacy migration and append reject Assistant-owned backing chats", () => {
  const storeMain = readFileSync(new URL("./design-project-store-main.ts", import.meta.url), "utf8");
  const connection = readFileSync(
    new URL("./design-project-connection-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    storeMain,
    /persistedChatWorkspaceId\(chat\.workspaceId\) === ASSISTANT_WORKSPACE_ID/u,
  );
  assert.match(connection, /await dependencies\.chatWorkspaceId\(project\.chatId\)/u);
  assert.match(connection, /Aiden Assistant conversations cannot back a Design Project/u);
});

test("Design picker messages require the exact frame source and main capability", () => {
  const frame = readFileSync(
    new URL("../../renderer/components/html-artifact-frame.tsx", import.meta.url),
    "utf8",
  );
  const composer = readFileSync(
    new URL("../../renderer/components/composer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(frame, /event\.source !== frameRef\.current\?\.contentWindow/u);
  assert.match(frame, /event\.data\.capability !== designPicker\.capability/u);
  assert.match(frame, /parseDesignElementSelection/u);
  assert.match(composer, /Canvas context for next message/u);
  assert.match(composer, /Remove \$\{item\.label\} from canvas context/u);
});

test("main prevents a live generative UI guest from navigating its own frame", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /webContents\.on\("will-frame-navigate"/u);
  assert.match(source, /shouldBlockGenerativeUiGuestNavigation/u);
  assert.match(source, /sourceDesignPreviewService\.frameNavigationAuthorities\(\)/u);
  assert.match(source, /event\.preventDefault\(\)/u);
});

test("source-backed Design uses exact React Grab context and mandatory reviewed writes", () => {
  const preview = readFileSync(new URL("./source-design-preview.ts", import.meta.url), "utf8");
  const actions = readFileSync(new URL("./source-designer-actions.ts", import.meta.url), "utf8");
  const extension = readFileSync(new URL("./source-designer-extension.ts", import.meta.url), "utf8");
  const workspace = readFileSync(
    new URL("../../renderer/components/design-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(preview, /primitives\.getElementAtPoint\(event\.clientX, event\.clientY\)/u);
  assert.match(preview, /getElementContext\(element\)/u);
  assert.match(preview, /shell: false/u);
  assert.match(preview, /127\.0\.0\.1/u);
  assert.match(actions, /exactJsxRange/u);
  assert.match(actions, /writeWorkspaceFile/u);
  assert.match(actions, /status: "pending"/u);
  assert.match(actions, /action\.afterVersion/u);
  assert.match(extension, /propose_design_action/u);
  assert.match(extension, /No files were changed/u);
  assert.match(workspace, /Review required/u);
  assert.match(workspace, /Undo exact action/u);
});

test("damaged generated bytes cannot cross code, export, edit, comment, or handoff boundaries", () => {
  const handlers = readFileSync(new URL("../handlers/designer.ts", import.meta.url), "utf8");
  const handoff = readFileSync(
    new URL("./design-handoff-application-service-main.ts", import.meta.url),
    "utf8",
  );
  const llm = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const directEdit = readFileSync(
    new URL("./design-direct-edit-service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(handlers, /committedSourceFor\(project\.chatId/u);
  assert.match(handlers, /isUsablePublishedDesignSource\(project, source\)/u);
  assert.match(handlers, /Repair it before continuing/u);
  assert.match(handlers, /Repair it before viewing code/u);
  assert.match(handlers, /Repair it before exporting/u);
  assert.match(handlers, /Repair it before editing/u);
  assert.match(handlers, /Repair it before adding comments/u);
  assert.match(handoff, /isUsablePublishedDesignSource\(project, source\)/u);
  assert.match(llm, /Design handoff source is damaged and must be repaired/u);
  assert.doesNotMatch(directEdit, /committedSourceFor/u);
  assert.match(directEdit, /isUsablePublishedDesignSource\(project, source\)/u);
  assert.match(directEdit, /isUsablePublishedDesignSource\(project, edited\)/u);
  assert.match(directEdit, /isUsablePublishedDesignSource\(project, revert\)/u);
});

test("optimistic Design preview has a live-only source lane while stored reads stay published", () => {
  const recovery = readFileSync(new URL("./gui-artifact-recovery.ts", import.meta.url), "utf8");
  const llm = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const chats = readFileSync(new URL("../handlers/chats.ts", import.meta.url), "utf8");
  const workspace = readFileSync(
    new URL("../../renderer/components/design-workspace.tsx", import.meta.url),
    "utf8",
  );
  const pane = readFileSync(new URL("../../renderer/main/chat-pane.tsx", import.meta.url), "utf8");
  assert.match(recovery, /liveDesignCandidateSourceFor/u);
  assert.match(recovery, /isUsableLiveDesignCandidateSource/u);
  assert.match(recovery, /liveSource \?\? \(await storedHtmlSource/u);
  assert.match(recovery, /finalSource = await storedHtmlSource/u);
  assert.doesNotMatch(recovery, /exportStoredHtmlArtifact[\s\S]*liveDesignCandidateSource/u);
  assert.match(llm, /designLivePreviewAuthority\.grant\(\{/u);
  assert.match(llm, /designLivePreviewAuthority\.revokeStream\(streamId\)/u);
  assert.match(
    llm,
    /catch \(error\) \{\s+designLivePreviewAuthority\.revokeStream\(streamId\);\s+if \(candidate\)/u,
    "candidate initialization failure revokes its pre-admitted preview authority",
  );
  assert.match(
    llm,
    /if \(!agent \|\| !piSession\) \{\s+designLivePreviewAuthority\.revokeStream\(streamId\);/u,
    "an incomplete initialized runtime revokes its pre-admitted preview authority",
  );
  assert.match(chats, /designStudio &&\s*requestedLiveGeneration/u);
  assert.match(chats, /designLivePreviewAuthority\.allows\(\{/u);
  assert.match(workspace, /revision\.source === "live" && livePreviewAuthority/u);
  assert.match(pane, /livePreviewAuthority=\{liveDesignPreviewAuthority\}/u);
});

test("Design terminal publication is decided before chat durability and published only after commit", () => {
  const source = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const decide = source.indexOf("await decideDesignGenerationPublication({");
  const append = source.indexOf("await chatStore.appendMessage(", decide);
  const settle = source.indexOf("await settleDecidedDesignGeneration({", append);
  assert.ok(decide >= 0 && decide < append);
  assert.ok(append < settle);
});
