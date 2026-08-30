import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDisplayImageExtension,
  createDisplayImageExtensionRuntime,
  displayedAssistantImageUsage,
  DISPLAY_IMAGE_EXTENSION_ID,
  DISPLAY_IMAGE_TOOL_NAME,
  MAX_DISPLAY_IMAGE_BYTES_PER_CHAT,
  MAX_DISPLAY_IMAGE_DIMENSION,
  MAX_DISPLAY_IMAGE_PIXELS,
  MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE,
  MAX_DISPLAY_IMAGES_PER_CHAT,
  shouldEnableDisplayImageExtension,
} from "./display-image-extension.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import { generationHasVisibleOutput } from "./generation-visible-output.js";
import type { ChatImageArtifactV1 } from "../../renderer/shared/chat-artifacts.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  "base64",
);

function pngWithDimensions(width: number, height: number): Buffer {
  const png = Buffer.from(ONE_PIXEL_PNG);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function pngWithAnimationControl(): Buffer {
  const iendType = ONE_PIXEL_PNG.indexOf(Buffer.from("IEND"));
  assert.ok(iendType >= 4);
  const chunkStart = iendType - 4;
  const animationControl = Buffer.alloc(20);
  animationControl.writeUInt32BE(8, 0);
  animationControl.write("acTL", 4, "ascii");
  animationControl.writeUInt32BE(1, 8);
  animationControl.writeUInt32BE(0, 12);
  return Buffer.concat([
    ONE_PIXEL_PNG.subarray(0, chunkStart),
    animationControl,
    ONE_PIXEL_PNG.subarray(chunkStart),
  ]);
}

function gifWithOutOfBoundsFrame(): Buffer {
  return Buffer.from([
    ...Buffer.from("GIF89a", "ascii"),
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    2,
    0,
    1,
    0,
    0,
    2,
    1,
    0,
    0,
    0x3b,
  ]);
}

function webpWithMismatchedEmbeddedFrame(): Buffer {
  const extended = Buffer.alloc(18);
  extended.write("VP8X", 0, "ascii");
  extended.writeUInt32LE(10, 4);
  const lossless = Buffer.alloc(14);
  lossless.write("VP8L", 0, "ascii");
  lossless.writeUInt32LE(5, 4);
  lossless[8] = 0x2f;
  lossless.writeUInt32LE(1, 9); // Embedded frame is 2×1; VP8X canvas is 1×1.
  const body = Buffer.concat([extended, lossless]);
  const webp = Buffer.alloc(12 + body.length);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(webp.length - 8, 4);
  webp.write("WEBP", 8, "ascii");
  body.copy(webp, 12);
  return webp;
}
const temporaryDirectories: string[] = [];

test("an artifact-only assistant reply is visible terminal output", () => {
  assert.equal(generationHasVisibleOutput("", 1), true);
  assert.equal(generationHasVisibleOutput("", 0), false);
  assert.equal(generationHasVisibleOutput("Done", 0), true);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-display-image-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("the first-party Pi extension emits a bounded structured image artifact", async () => {
  const root = await workspace();
  await fs.mkdir(path.join(root, "previews"));
  await fs.writeFile(path.join(root, "previews", "page.png"), ONE_PIXEL_PNG);
  const artifacts: ChatImageArtifactV1[] = [];
  const extension = createDisplayImageExtension({
    workspaceRoot: root,
    onArtifact: (artifact) => {
      artifacts.push(artifact);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.equal(extension.id, DISPLAY_IMAGE_EXTENSION_ID);
  assert.match(extension.systemPrompt ?? "", /display_image/u);
  assert.equal(tool.name, DISPLAY_IMAGE_TOOL_NAME);
  assert.equal(piRuntimeReplayPolicy(tool), "never");

  const result = await tool.execute("call-1", { path: "previews/page.png" });
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /1×1/u);
  assert.equal(artifacts.length, 1);
  assert.deepEqual(artifacts[0], {
    version: 1,
    kind: "image",
    attachment: {
      id: artifacts[0]?.attachment.id,
      name: "page.png",
      mimeType: "image/png",
      kind: "image",
      size: ONE_PIXEL_PNG.length,
      data: ONE_PIXEL_PNG.toString("base64"),
    },
  });
});

test("display_image rejects absolute paths and workspace escapes", async () => {
  const root = await workspace();
  const extension = createDisplayImageExtension({
    workspaceRoot: root,
    onArtifact: () => {},
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(tool.execute("absolute", { path: "/tmp/outside.png" }), /relative/iu);
  await assert.rejects(tool.execute("escape", { path: "../outside.png" }), /outside/iu);
});

test("display_image reads an authorized workspace opened through a symlink", async () => {
  const root = await workspace();
  const linkParent = await workspace();
  const linkedRoot = path.join(linkParent, "linked-workspace");
  await fs.writeFile(path.join(root, "page.png"), ONE_PIXEL_PNG);
  await fs.symlink(root, linkedRoot, "dir");
  let emitted = false;
  const extension = createDisplayImageExtension({
    workspaceRoot: linkedRoot,
    onArtifact: () => {
      emitted = true;
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);

  await tool.execute("linked-root", { path: "page.png" });

  assert.equal(emitted, true);
});

test("display_image rejects dangerous decoded dimensions before emitting", async () => {
  const root = await workspace();
  const oversized = Buffer.from(ONE_PIXEL_PNG);
  oversized.writeUInt32BE(MAX_DISPLAY_IMAGE_DIMENSION + 1, 16);
  oversized.writeUInt32BE(1, 20);
  await fs.writeFile(path.join(root, "oversized.png"), oversized);
  let emitted = false;
  const extension = createDisplayImageExtension({
    workspaceRoot: root,
    onArtifact: () => {
      emitted = true;
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(tool.execute("large", { path: "oversized.png" }), /decode safely/iu);
  assert.equal(emitted, false);
});

test("display_image rejects truncated raster bodies before claiming display", async () => {
  const root = await workspace();
  const truncated = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(truncated);
  truncated.writeUInt32BE(1, 16);
  truncated.writeUInt32BE(1, 20);
  await fs.writeFile(path.join(root, "truncated.png"), truncated);
  let emitted = false;
  const extension = createDisplayImageExtension({
    workspaceRoot: root,
    onArtifact: () => {
      emitted = true;
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(tool.execute("truncated", { path: "truncated.png" }), /malformed/iu);
  assert.equal(emitted, false);
});

test("display_image rejects animated and oversized embedded raster frames", async () => {
  const root = await workspace();
  const hostile = [
    ["animated.png", pngWithAnimationControl()],
    ["frame.gif", gifWithOutOfBoundsFrame()],
    ["frame.webp", webpWithMismatchedEmbeddedFrame()],
  ] as const;
  const extension = createDisplayImageExtension({
    workspaceRoot: root,
    onArtifact: () => {},
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  for (const [name, bytes] of hostile) {
    await fs.writeFile(path.join(root, name), bytes);
    await assert.rejects(tool.execute(name, { path: name }), /malformed/iu);
  }
});

test("display_image enforces an aggregate decoded-pixel budget per response", async () => {
  const root = await workspace();
  const width = 5_000;
  const height = MAX_DISPLAY_IMAGE_PIXELS / width;
  assert.equal(width * height * 2, MAX_DISPLAY_IMAGE_PIXELS_PER_RESPONSE);
  for (const name of ["first.png", "second.png", "third.png"]) {
    await fs.writeFile(path.join(root, name), pngWithDimensions(width, height));
  }
  const extension = createDisplayImageExtension({
    workspaceRoot: root,
    onArtifact: () => {},
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("first", { path: "first.png" });
  await tool.execute("second", { path: "second.png" });
  await assert.rejects(tool.execute("third", { path: "third.png" }), /decoded-pixel/iu);
});

test("cancellation immediately before presentation emits no artifact", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "page.png"), ONE_PIXEL_PNG);
  const controller = new AbortController();
  let emitted = false;
  const extension = createDisplayImageExtension({
    workspaceRoot: root,
    beforeArtifact: () => controller.abort(),
    onArtifact: () => {
      emitted = true;
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(
    tool.execute("cancelled", { path: "page.png" }, controller.signal),
    /cancelled/iu,
  );
  assert.equal(emitted, false);
});

test("scope and cumulative quotas keep the extension bounded to foreground workspace chat", async () => {
  const base = {
    usageSource: "chat",
    interactionSurface: undefined,
    assistantMode: false,
    workspaceRoot: "/workspace",
    permission: "ask",
    excluded: false,
  };
  assert.equal(shouldEnableDisplayImageExtension(base), true);
  assert.equal(shouldEnableDisplayImageExtension({ ...base, usageSource: "scheduled" }), false);
  assert.equal(
    shouldEnableDisplayImageExtension({
      ...base,
      interactionSurface: "telegram",
    }),
    false,
  );
  assert.equal(shouldEnableDisplayImageExtension({ ...base, assistantMode: true }), false);
  assert.equal(shouldEnableDisplayImageExtension({ ...base, workspaceRoot: undefined }), false);
  assert.equal(shouldEnableDisplayImageExtension({ ...base, permission: "none" }), false);
  assert.equal(shouldEnableDisplayImageExtension({ ...base, excluded: true }), false);

  assert.deepEqual(
    displayedAssistantImageUsage([
      { role: "user", attachments: [{ kind: "image", size: 50 }] },
      {
        role: "assistant",
        attachments: [
          {
            kind: "image",
            size: ONE_PIXEL_PNG.length,
            mimeType: "image/png",
            data: ONE_PIXEL_PNG.toString("base64"),
          },
        ],
      },
      { role: "assistant", attachments: [{ kind: "text", size: 100 }] },
    ]),
    { bytes: ONE_PIXEL_PNG.length, count: 1, pixels: 1 },
  );

  const root = await workspace();
  await fs.writeFile(path.join(root, "page.png"), ONE_PIXEL_PNG);
  for (const options of [
    { existingChatImageBytes: MAX_DISPLAY_IMAGE_BYTES_PER_CHAT },
    { existingChatImageCount: MAX_DISPLAY_IMAGES_PER_CHAT },
  ]) {
    const extension = createDisplayImageExtension({
      workspaceRoot: root,
      ...options,
      onArtifact: () => {},
    });
    const tool = extension.tools?.[0];
    assert.ok(tool);
    await assert.rejects(tool.execute("quota", { path: "page.png" }), /limit/iu);
  }
});

test("provider retries retain already-presented artifacts and their response budget", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "page.png"), ONE_PIXEL_PNG);
  let emitted = 0;
  const runtime = createDisplayImageExtensionRuntime({
    workspaceRoot: root,
    onArtifact: () => {
      emitted += 1;
    },
  });
  const tool = runtime.extension.tools?.[0];
  assert.ok(tool);
  for (let index = 0; index < 20; index += 1) {
    await tool.execute(`before-retry-${index}`, { path: "page.png" });
  }
  await assert.rejects(tool.execute("after-retry", { path: "page.png" }), /up to 20 images/iu);
  assert.equal(emitted, 20);
});

test("duplicate tool delivery does not consume presentation quota twice", async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, "page.png"), ONE_PIXEL_PNG);
  const presented = new Set<string>();
  let emitted = 0;
  const runtime = createDisplayImageExtensionRuntime({
    workspaceRoot: root,
    onArtifact: (artifact) => {
      if (presented.has(artifact.attachment.id)) return false;
      presented.add(artifact.attachment.id);
      emitted += 1;
      return true;
    },
  });
  const tool = runtime.extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("duplicate", { path: "page.png" });
  await tool.execute("duplicate", { path: "page.png" });
  for (let index = 0; index < 19; index += 1) {
    await tool.execute(`unique-${index}`, { path: "page.png" });
  }

  assert.equal(emitted, 20);
  await assert.rejects(tool.execute("over-limit", { path: "page.png" }), /up to 20 images/iu);
});
