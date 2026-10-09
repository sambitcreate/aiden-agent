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
import { remoteGenerationSurface } from "./conversation-surface-generation.js";
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

test("visuals are available without a workspace and follow the inline-visuals mode", () => {
  const base = { usageSource: "chat", assistantMode: false, permission: "none", excluded: false };
  assert.equal(shouldEnableGenerativeUiExtension({ ...base }), true);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, inlineVisuals: "automatic" }), true);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, inlineVisuals: "off", visualize: true }), false);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, inlineVisuals: "on_request" }), false);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, inlineVisuals: "on_request", visualize: true }), true);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, usageSource: "scheduled" }), false);
  assert.equal(shouldEnableGenerativeUiExtension({ ...base, excluded: true }), false);
});

test("turns sent from a paired phone do not get inline visuals until phones can show them", () => {
  const surface = remoteGenerationSurface({
    chatId: "chat", turnId: "turn", streamId: "stream", ownerId: "owner",
    workspaceId: "workspace", providerId: "provider", model: "model",
    onTurnAccepted: () => undefined,
  });
  assert.equal(
    shouldEnableGenerativeUiExtension({
      usageSource: surface.options.usageSource,
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
      inlineVisuals: surface.params.inlineVisuals,
    }),
    false,
  );
});

test("path rendering is refused without a workspace while inline html works", async () => {
  const artifacts: ChatHtmlArtifactV1[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: undefined,
    onArtifact: (artifact) => {
      artifacts.push(artifact);
    },
  });
  const tool = extension.tools?.find((candidate) => candidate.name === GENERATIVE_UI_TOOL_NAME);
  assert.ok(tool);
  await assert.rejects(tool.execute("c1", { title: "T", path: "a.html" }), /workspace/iu);
  await tool.execute("c2", { title: "T", html: "<p>x</p>" });
  assert.equal(artifacts.length, 1);
});

test("visualize_guide returns only the requested design modules", async () => {
  const root = await workspace();
  const extension = createGenerativeUiExtension({ workspaceRoot: root, onArtifact: () => undefined });
  const guide = extension.tools?.find((candidate) => candidate.name === "visualize_guide");
  assert.ok(guide);
  assert.equal(piRuntimeReplayPolicy(guide), "never");
  const text = async (modules: unknown) => {
    const result = await guide.execute("g1", { modules });
    return result.content[0]?.type === "text" ? result.content[0].text : "";
  };
  const charts = await text(["charts"]);
  assert.match(charts, /aiden\.series\(\)/u);
  assert.doesNotMatch(charts, /## HTML structure/u);
  const html = await text(["html", "design"]);
  assert.match(html, /## HTML structure/u);
  assert.match(html, /aiden-card/u);
  assert.match(html, /do not (re)?declare `aiden`/iu);
  await assert.rejects(guide.execute("g2", { modules: ["nope"] }), /module/iu);
});

test("the system prompt points the model at the guide and keeps replies complete without visuals", () => {
  const extension = createGenerativeUiExtension({ workspaceRoot: undefined, onArtifact: () => undefined });
  assert.match(extension.systemPrompt ?? "", /visualize_guide/u);
  assert.match(extension.systemPrompt ?? "", /takeaway/iu);
  const preferred = createGenerativeUiExtension({
    workspaceRoot: undefined,
    preferArtifactThisTurn: true,
    onArtifact: () => undefined,
  });
  assert.match(preferred.systemPrompt ?? "", /\/visualize/u);
});

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
  await tool.execute("call-a", { title: "Chart", html: "<p>aaa</p>" });
  await tool.execute("call-b", { title: "Chart", html: "<p>bbb</p>" });
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0]?.mediaId, artifacts[1]?.mediaId);
  assert.equal(artifacts[0]?.size, artifacts[1]?.size);
  assert.notEqual(artifacts[0]?.id, artifacts[1]?.id);
});

test("onArtifact receives the producing toolCallId and replaces keep the first call", async () => {
  const root = await workspace();
  const seen: string[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    artifactNamespace: "gen-call",
    onArtifact: (_artifact, _html, context) => {
      seen.push(context.toolCallId);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("call-first", { title: "Chart", html: "<p>a</p>" });
  await tool.execute("call-second", { title: "Chart", html: "<p>b</p>" });
  await tool.execute("call-other", { title: "Other", html: "<p>c</p>" });
  assert.deepEqual(seen, ["call-first", "call-first", "call-other"]);
});

test("render_artifact refuses intermediate directory symlinks", async () => {
  if (process.platform !== "darwin") return;
  const root = await workspace();
  const outside = await workspace();
  await fs.writeFile(path.join(outside, "secret.html"), "<p>secret</p>");
  await fs.mkdir(path.join(root, "plots"));
  await fs.symlink(outside, path.join(root, "plots", "leak"));
  const extension = createGenerativeUiExtension({
    workspaceRoot: root,
    onArtifact: () => undefined,
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await assert.rejects(
    tool.execute("symlink", { title: "Leak", path: path.join("plots", "leak", "secret.html") }),
    /could not be read safely/iu,
  );
});

test("render_artifact reads nested HTML through a canonicalized root alias", async () => {
  if (process.platform !== "darwin") return;
  const root = await workspace();
  const aliasParent = await workspace();
  const alias = path.join(aliasParent, "workspace-link");
  await fs.mkdir(path.join(root, "plots"));
  await fs.writeFile(path.join(root, "plots", "chart.html"), "<p>workspace chart</p>");
  await fs.symlink(root, alias);
  const htmlBodies: string[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: alias,
    onArtifact: (_artifact, html) => {
      htmlBodies.push(html);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);

  await tool.execute("root-alias", {
    title: "Chart",
    path: path.join("plots", "chart.html"),
  });
  assert.deepEqual(htmlBodies, ["<p>workspace chart</p>"]);
});
