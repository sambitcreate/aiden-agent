import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Design turns retain the model backend but use a positive tool and extension allowlist", () => {
  const source = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const extension = readFileSync(new URL("./generative-ui-extension.ts", import.meta.url), "utf8");
  assert.match(source, /const designWorkspace = params\.design === true/u);
  assert.match(source, /designProjectStore\.getByChatId\(params\.chatId\)/u);
  assert.match(source, /authoritativeDesignGenerationWorkspaceId/u);
  assert.match(
    source,
    /params\.design\s*\? persistedChatWorkspaceId\(chat\.workspaceId\)\s*:\s*authoritativeChatWorkspaceId/u,
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
  assert.match(source, /if \(designWorkspace\) tools = \[\]/u);
  assert.match(
    source,
    /params\.design === true\s*\? generationExtensions\s*:\s*\[\s*\.\.\.runtimeExtensionSnapshot\.extensions/u,
  );
  assert.match(source, /!designWorkspace &&\s*options\.allowComputerUse/u);
  assert.match(source, /!designWorkspace &&\s*!botContext &&\s*shouldEnableDisplayImageExtension/u);
  assert.match(source, /designWorkspaceThisTurn: designWorkspace/u);
  assert.match(source, /generativeUiArtifactStore\.htmlFor/u);
  assert.match(source, /artifact\.mediaId === target\.mediaId/u);
  assert.match(source, /artifact\.id === target\.artifactId/u);
  assert.match(source, /selected Design canvas item is stale/u);
  assert.match(source, /priorDesigns/u);
  assert.match(extension, /omitHistoricalDesignHtml/u);
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
