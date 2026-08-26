import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";

const source = readFileSync(
  new URL("./onboarding-flow.tsx", import.meta.url),
  "utf8",
);
const agentsInstructions = readFileSync(
  new URL("../../AGENTS.md", import.meta.url),
  "utf8",
);
const featureAssetPaths = [
  "aiden-workspace.png",
  "features/aiden-assistant.png",
  "features/ambient-music.png",
  "features/attachments-vision.png",
  "features/command-palette.png",
  "features/computer-use.png",
  "features/files-editor.png",
  "features/git-workflows.png",
  "features/mcp-connectors.png",
  "features/model-freedom.png",
  "features/model-pad.png",
  "features/native-subagents.png",
  "features/permissions.png",
  "features/review-diffs.png",
  "features/scheduled-automations.png",
  "features/skills.png",
  "features/terminal.png",
  "features/themes-accessibility.png",
  "features/thinking-controls.png",
  "features/usage-profile.png",
  "features/voice-dictation.png",
  "features/web-search.png",
  "features/workspaces-worktrees.png",
] as const;
const providerPresentation = source.slice(
  source.indexOf("const providerChoices"),
  source.indexOf("function makeProvider"),
);
const featurePresentation = source.slice(
  source.indexOf("const featureBentos"),
  source.indexOf("function makeProvider"),
);

function paethPredictor(left: number, up: number, upperLeft: number): number {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance)
    return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function hasTransparentPixel(png: Buffer): boolean {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(png[24], 8, "onboarding PNGs must use 8-bit channels");
  assert.equal(png[25], 6, "onboarding PNGs must use RGBA color");
  assert.equal(png[28], 0, "onboarding PNGs must not be interlaced");

  const imageChunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT")
      imageChunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === "IEND") break;
  }
  assert.ok(imageChunks.length > 0, "onboarding PNG must contain image data");

  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(imageChunks));
  assert.equal(
    filtered.length,
    height * (rowBytes + 1),
    "unexpected PNG image-data size",
  );
  const decoded = Buffer.alloc(height * rowBytes);
  let inputOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[inputOffset];
    inputOffset += 1;
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = filtered[inputOffset + column];
      const left =
        column >= bytesPerPixel
          ? decoded[rowOffset + column - bytesPerPixel]
          : 0;
      const up = row > 0 ? decoded[rowOffset + column - rowBytes] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? decoded[rowOffset + column - rowBytes - bytesPerPixel]
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paethPredictor(left, up, upperLeft)
                  : -1;
      assert.notEqual(predictor, -1, `unsupported PNG filter ${filter}`);
      decoded[rowOffset + column] = (encoded + predictor) & 0xff;
    }
    inputOffset += rowBytes;
  }
  for (let alpha = 3; alpha < decoded.length; alpha += bytesPerPixel) {
    if (decoded[alpha] < 255) return true;
  }
  return false;
}

test("onboarding uses the Aiden mark and the existing provider icon system", () => {
  assert.match(source, /resources\/app-icon\.png/u);
  assert.match(source, /<ProviderIcon/u);
  for (const providerId of [
    "openai",
    "openai-codex",
    "anthropic",
    "lmstudio",
    "ollama",
  ]) {
    assert.match(
      providerPresentation,
      new RegExp(`iconProviderId: "${providerId}"`, "u"),
    );
  }
  assert.match(source, /aria-pressed=\{choice === item\.id\}/u);
});

test("onboarding keeps navigation fixed while its content scrolls", () => {
  assert.match(
    source,
    /data-onboarding-scroll[\s\S]*?className="[^"]*min-h-0[^"]*overflow-y-auto[^"]*"/u,
  );
  assert.match(
    source,
    /data-onboarding-footer[\s\S]*?className="[^"]*shrink-0[^"]*border-t[^"]*"/u,
  );
  assert.match(source, /h-\[min\(600px,calc\(100vh-32px\)\)\]/u);
  assert.match(
    source,
    /ref=\{scrollContainerRef\}[\s\S]*?data-onboarding-scroll/u,
  );
  assert.match(
    source,
    /scrollContainerRef\.current\?\.scrollTo\(\{ top: 0, behavior: "auto" \}\);[\s\S]*?\}, \[index\]\);/u,
  );
});

test("provider setup progressively reveals the complete live Pi catalog", () => {
  assert.match(source, />\s*Choose from more\s*</u);
  assert.match(source, /aria-controls="onboarding-more-providers"/u);
  assert.match(source, /aria-expanded=\{showMoreProviders\}/u);
  assert.match(source, /data-onboarding-more-providers/u);
  assert.match(
    source,
    /getOnboardingMoreProviders\(providers\.data \?\? \[\]\)/u,
  );
  assert.match(source, /providers\.isLoading/u);
  assert.match(source, /providers\.isError/u);
  assert.match(source, /providers\.refetch\(\)/u);
  assert.match(source, /disabled=\{!canChoose \|\| saving\}/u);
  assert.match(source, /<BuiltinProviderEditor[\s\S]*?layer="onboarding"/u);
  assert.match(
    source,
    /provider\.id === "openai-codex"[\s\S]*?provider\.isBuiltin === true/u,
  );
  assert.match(source, /setSettingUpProvider\(chatGptProvider\)/u);
  assert.doesNotMatch(source, /providersApi\.authStart/u);
});

test("onboarding traps focus and locks navigation during durable writes", () => {
  assert.match(source, /<DialogPrimitive\.Root open>/u);
  assert.match(source, /<DialogPrimitive\.Content/u);
  assert.match(
    source,
    /onEscapeKeyDown=\{\(event\) => event\.preventDefault\(\)\}/u,
  );
  assert.match(
    source,
    /<DialogPrimitive\.Title className="sr-only">Set up Aiden/u,
  );
  assert.match(source, /if \(!canContinue \|\| savingRef\.current\) return/u);
  assert.match(source, /aria-busy=\{saving \|\| undefined\}/u);
  assert.match(
    source,
    /variant="transparent"[\s\S]*?disabled=\{saving\}[\s\S]*?>\s*Skip/u,
  );
  assert.ok((source.match(/disabled=\{saving\}/gu) ?? []).length >= 6);
});

test("onboarding presentation stays compact and free of decorative gradients", () => {
  assert.doesNotMatch(source, /blur-3xl|backdrop-blur|bg-gradient/u);
  assert.doesNotMatch(
    providerPresentation,
    /footnote|Default URL|127\.0\.0\.1/u,
  );
  assert.doesNotMatch(
    providerPresentation,
    /The key stays on this Mac and can be rotated later in Settings\./u,
  );
});

test("the final step is a complete grouped bento gallery with hover and keyboard descriptions", () => {
  assert.match(source, /data-onboarding-bento/u);
  assert.match(
    source,
    /data-onboarding-feature-count=\{visibleFeatureBentos\.length\}/u,
  );
  assert.match(
    source,
    /featureBentos\.filter\(\(feature\) => feature\.id !== "ambientMusic"\)/u,
  );
  assert.match(source, /auto-rows-\[118px\][\s\S]*?grid-cols-6/u);
  assert.match(source, /FEATURE_LAYOUTS[\s\S]*?col-span-4 row-span-2/u);
  assert.match(source, /group-hover:opacity-100/u);
  assert.match(source, /group-focus:opacity-100/u);
  assert.match(
    source,
    /Use Command-K or \/ for app commands, and \$ to attach a reusable skill\./u,
  );
  assert.match(
    source,
    /Create reusable instructions, then type \$ to attach one to your next message\./u,
  );
  assert.match(source, /tabIndex=\{0\}/u);
  for (const group of [
    "Build in your workspace",
    "Choose and extend",
    "Automate and stay in control",
  ]) {
    assert.match(source, new RegExp(group, "u"));
  }
  for (const title of [
    "Workspace Agent",
    "Computer Use",
    "Native Subagents",
    "Files & Text Editor",
    "Review & Diffs",
    "Integrated Terminal",
    "Git Workflows",
    "Workspaces & Worktrees",
    "Model Freedom",
    "Personal Model Pad",
    "Thinking Controls",
    "Attachments & Vision",
    "Web Search",
    "Reusable Skills",
    "MCP Connectors",
    "Aiden Assistant",
    "Scheduled Automations",
    "Voice & Dictation",
    "Ambient Music",
    "Command Palette",
    "Private Usage Profile",
    "Permissioned by Default",
    "Themes & Accessibility",
  ]) {
    assert.match(featurePresentation, new RegExp(title, "u"));
  }
  assert.equal(
    featurePresentation.match(/imageUrl: FEATURE_ILLUSTRATIONS\./gu)?.length,
    23,
  );
  assert.match(
    featurePresentation,
    /Generate live focus music on this Mac after you choose to download an on-device model\./u,
  );
  assert.doesNotMatch(featurePresentation, /ambientMusicApi|downloadModel\(/u);
  assert.doesNotMatch(
    featurePresentation,
    /Designer Mode|Image Generation|Proactive nudges/u,
  );
});

test("every advertised feature has its own one-megapixel PNG with alpha", () => {
  assert.equal(featureAssetPaths.length, 23);
  assert.equal(new Set(featureAssetPaths).size, featureAssetPaths.length);
  for (const assetPath of featureAssetPaths) {
    const illustration = readFileSync(
      new URL(`../assets/onboarding/${assetPath}`, import.meta.url),
    );
    assert.deepEqual(
      [...illustration.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      assetPath,
    );
    assert.equal(illustration.readUInt32BE(16), 1024, assetPath);
    assert.equal(illustration.readUInt32BE(20), 1024, assetPath);
    assert.equal(illustration[25], 6, assetPath);
    assert.equal(hasTransparentPixel(illustration), true, assetPath);
  }
});

test("project guidance keeps the feature bento current as Aiden evolves", () => {
  assert.match(agentsInstructions, /feature-tour bento gallery/u);
  assert.match(agentsInstructions, /1024 × 1024 transparent PNG/u);
});
