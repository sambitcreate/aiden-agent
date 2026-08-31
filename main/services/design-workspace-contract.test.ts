import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Design turns retain the model backend but use a positive tool and extension allowlist", () => {
  const source = readFileSync(new URL("./llm-client.ts", import.meta.url), "utf8");
  const extension = readFileSync(new URL("./generative-ui-extension.ts", import.meta.url), "utf8");
  assert.match(source, /const designWorkspace = params\.design === true/u);
  assert.match(source, /Design workspace is unavailable for this conversation/u);
  assert.match(source, /shouldEnableDesignWorkspace/u);
  assert.match(source, /botBound: botContext !== undefined/u);
  assert.match(source, /permission,\s*excluded:/u);
  assert.match(source, /if \(designWorkspace\) tools = \[\]/u);
  assert.match(
    source,
    /params\.design === true\s*\? generationExtensions\s*:\s*\[\.\.\.runtimeExtensionSnapshot\.extensions/u,
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
