import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createGenerativeUiExtension,
  GENERATIVE_UI_EXTENSION_ID,
  GENERATIVE_UI_TOOL_NAME,
  shouldEnableGenerativeUiExtension,
} from "./generative-ui-extension.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-genui-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("generative UI enablement matches the display_image chat gate", () => {
  assert.equal(
    shouldEnableGenerativeUiExtension({
      usageSource: "chat",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
    }),
    true,
  );
  assert.equal(
    shouldEnableGenerativeUiExtension({
      usageSource: "chat",
      interactionSurface: "telegram",
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
    }),
    false,
  );
  assert.equal(
    shouldEnableGenerativeUiExtension({
      usageSource: "chat",
      assistantMode: true,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
    }),
    false,
  );
});

test("render_artifact emits metadata only and never returns HTML to the model", async () => {
  const root = await workspace();
  const artifacts: ChatHtmlArtifactV1[] = [];
  const htmlBodies: string[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    onArtifact: (artifact, html) => {
      artifacts.push(artifact);
      htmlBodies.push(html);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  assert.equal(extension.id, GENERATIVE_UI_EXTENSION_ID);
  assert.equal(tool.name, GENERATIVE_UI_TOOL_NAME);
  assert.equal(piRuntimeReplayPolicy(tool), "never");
  const html = "<h1>Chart</h1><canvas id=\"c\"></canvas>";
  const result = await tool.execute("call-1", { title: "Chart", html });
  assert.equal(result.content[0]?.type, "text");
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /<canvas/u);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.title, "Chart");
  assert.equal(htmlBodies[0], html);
});

test("render_artifact rejects path escapes, oversize HTML, and cancelled work", async () => {
  const root = await workspace();
  let emitted = 0;
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    onArtifact: () => {
      emitted += 1;
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(tool.execute("abs", { title: "X", path: "/tmp/x.html" }), /relative/iu);
  await assert.rejects(tool.execute("esc", { title: "X", path: "../x.html" }), /outside/iu);
  await assert.rejects(
    tool.execute("both", { title: "X", html: "<p>a</p>", path: "a.html" }),
    /exactly one/iu,
  );
  const huge = `<p>${"n".repeat(512 * 1024)}</p>`;
  await assert.rejects(tool.execute("huge", { title: "X", html: huge }), /exceeds/iu);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    tool.execute("cancel", { title: "X", html: "<p>ok</p>" }, abort.signal),
    /cancelled/iu,
  );
  assert.equal(emitted, 0);
});

test("same-generation title replaces the previous staged artifact", async () => {
  const root = await workspace();
  const artifacts: ChatHtmlArtifactV1[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    artifactNamespace: "gen-1",
    onArtifact: (artifact) => {
      artifacts.push(artifact);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("call-a", { title: "Chart", html: "<p>one</p>" });
  await tool.execute("call-b", { title: "Chart", html: "<p>two</p>" });
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0]?.mediaId, artifacts[1]?.mediaId);
});
