import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createGenerativeUiExtension,
  createVisualizeGuideTool,
  GENERATIVE_UI_EXTENSION_ID,
  GENERATIVE_UI_TOOL_NAME,
  shouldEnableGenerativeUiExtension,
} from "./generative-ui-extension.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";
import { remoteGenerationSurface } from "./conversation-surface-generation.js";
import type { InlineVisualsMode } from "../../renderer/shared/appearance.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import { AIDEN_UI_CATALOG } from "../../renderer/shared/aiden-ui/catalog.js";
import { compileAum } from "../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_GUIDE_EXAMPLE } from "./generative-ui-guide.js";

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

test("render_ui is offered only when the host can present native visuals", async () => {
  const presented: string[] = [];
  const withUi = createGenerativeUiExtension({
    workspaceRoot: undefined,
    onArtifact: () => undefined,
    onUiVisual: (visual) => {
      presented.push(visual.title);
    },
  });
  const names = withUi.tools?.map((tool) => tool.name);
  assert.deepEqual(names, [GENERATIVE_UI_TOOL_NAME, "render_ui", "visualize_guide"]);
  const renderUi = withUi.tools?.find((tool) => tool.name === "render_ui");
  await renderUi?.execute("call-1", { title: "Board", markup: "<Visual><Text>Hi</Text></Visual>" });
  assert.deepEqual(presented, ["Board"]);
  const htmlOnly = createGenerativeUiExtension({ workspaceRoot: undefined, onArtifact: () => undefined });
  assert.deepEqual(htmlOnly.tools?.map((tool) => tool.name), [GENERATIVE_UI_TOOL_NAME, "visualize_guide"]);
});

test("the catalog guide documents every component and its example compiles cleanly", async () => {
  const extension = createGenerativeUiExtension({ workspaceRoot: undefined, onArtifact: () => undefined });
  const guide = extension.tools?.find((tool) => tool.name === "visualize_guide");
  const result = await guide!.execute("g", { modules: ["catalog"] });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  for (const name of Object.keys(AIDEN_UI_CATALOG)) assert.match(text, new RegExp(`\`${name}\``, "u"), name);
  // List props say what one item looks like, not "any".
  const line = (name: string) => text.split("\n").find((entry) => entry.startsWith(`- \`${name}\``)) ?? "";
  assert.match(line("Checklist"), /items: list of \{label, done\}/u);
  assert.match(line("Timeline"), /items: list of \{title, time\?, description\?\}/u);
  assert.match(line("Sparkline"), /values: list of number/u);
  assert.doesNotMatch(line("Table"), /rows: any|columns: any/u);
  const compiled = compileAum(AIDEN_UI_GUIDE_EXAMPLE);
  assert.deepEqual(compiled.diagnostics, []);
  assert.ok(text.includes(AIDEN_UI_GUIDE_EXAMPLE));
});

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

test("turns sent from a paired device follow the desktop's inline visuals setting", () => {
  const enabledFor = (inlineVisuals?: InlineVisualsMode) => {
    const surface = remoteGenerationSurface({
      chatId: "chat", turnId: "turn", streamId: "stream", ownerId: "owner",
      workspaceId: "workspace", providerId: "provider", model: "model",
      ...(inlineVisuals ? { inlineVisuals } : {}),
      onTurnAccepted: () => undefined,
    });
    return shouldEnableGenerativeUiExtension({
      usageSource: surface.options.usageSource,
      assistantMode: false,
      workspaceRoot: "/tmp/ws",
      permission: "ask",
      excluded: false,
      inlineVisuals: surface.params.inlineVisuals,
    });
  };
  // Phones see each visual as its snapshot, so they follow Appearance.
  assert.equal(enabledFor("automatic"), true);
  assert.equal(enabledFor(), true);
  assert.equal(enabledFor("on_request"), false);
  assert.equal(enabledFor("off"), false);
});

test("a remote turn tells the model its visuals arrive as still images", () => {
  const surface = remoteGenerationSurface({
    chatId: "chat", turnId: "turn", streamId: "stream", ownerId: "owner",
    workspaceId: "workspace", providerId: "provider", model: "model",
    onTurnAccepted: () => undefined,
  });
  const remote = createGenerativeUiExtension({
    workspaceRoot: undefined,
    onArtifact: () => undefined,
    audience: surface.options.visualAudience,
  });
  assert.match(remote.systemPrompt ?? "", /still image/iu);
  const desktop = createGenerativeUiExtension({ workspaceRoot: undefined, onArtifact: () => undefined });
  assert.doesNotMatch(desktop.systemPrompt ?? "", /still image/iu);
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

test("with inline visuals off, the guide still teaches artifact markup and never mentions chat visual tools", async () => {
  const guide = createVisualizeGuideTool({ inlineVisuals: false });
  assert.equal(guide.name, "visualize_guide");
  assert.equal(piRuntimeReplayPolicy(guide), "never");
  assert.match(guide.description, /workspace_artifact/u);
  const result = await guide.execute("g", { modules: ["catalog"] });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  for (const name of Object.keys(AIDEN_UI_CATALOG)) assert.match(text, new RegExp(`\`${name}\``, "u"), name);
  assert.match(text, /setState/u);
  assert.match(text, /64 KiB/u);
  assert.doesNotMatch(`${guide.description}\n${text}`, /render_ui|render_artifact|inline visual/iu);
  // The HTML-only modules teach render_artifact, which is not offered then.
  await assert.rejects(guide.execute("g2", { modules: ["html"] }), /must be one or more of: catalog\./u);
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

test("with the design canvas offered, mockups and pages go to design files rather than inline visuals", () => {
  const steering = (extension: ReturnType<typeof createGenerativeUiExtension>) => {
    const renderArtifact = extension.tools?.find((tool) => tool.name === "render_artifact");
    assert.ok(renderArtifact);
    return { prompt: extension.systemPrompt ?? "", description: renderArtifact.description };
  };
  const chat = steering(createGenerativeUiExtension({ workspaceRoot: undefined, onArtifact: () => undefined }));
  assert.match(chat.prompt, /UI mockup/u);
  assert.match(chat.description, /UI mockups/u);
  assert.doesNotMatch(chat.prompt, /design canvas/iu);

  for (const preferArtifactThisTurn of [false, true]) {
    const canvas = steering(
      createGenerativeUiExtension({
        workspaceRoot: undefined,
        designCanvas: true,
        preferArtifactThisTurn,
        onArtifact: () => undefined,
      }),
    );
    for (const text of [canvas.prompt, canvas.description]) {
      assert.match(text, /design\/\*\.html/u);
      assert.match(text, /design canvas/iu);
    }
    // Mockups, screens and dashboards are only ever named as what does not belong inline.
    const inlineUses = canvas.prompt.replace(/[^.]*design canvas[^.]*\./giu, "");
    assert.doesNotMatch(inlineUses, /mockup|dashboard|screen/iu);
    assert.doesNotMatch(canvas.description.replace(/[^;.]*design canvas[^;.]*/giu, ""), /mockup|dashboard|screen/iu);
  }
  assert.doesNotMatch(chat.prompt + chat.description, /design_mode/u);
});

test("while design mode can be asked for, whole pages and several directions go to design_mode", () => {
  const steering = (options: { designCanvas?: boolean }) => {
    const extension = createGenerativeUiExtension({
      workspaceRoot: undefined,
      designModeOffered: true,
      ...options,
      onArtifact: () => undefined,
    });
    const renderArtifact = extension.tools?.find((tool) => tool.name === "render_artifact");
    assert.ok(renderArtifact);
    return { prompt: extension.systemPrompt ?? "", description: renderArtifact.description };
  };
  const offered = steering({});
  for (const text of [offered.prompt, offered.description]) {
    assert.match(text, /design_mode/u);
    assert.match(text, /app screens/u);
    assert.match(text, /several design directions/u);
  }
  assert.doesNotMatch(offered.description, /UI mockups/u);
  // Once the canvas is open, the visuals point to design/ files, not to asking again.
  const open = steering({ designCanvas: true });
  assert.doesNotMatch(open.prompt + open.description, /design_mode/u);
  assert.match(open.prompt, /design\/\*\.html/u);
});

test("render_artifact takes a column or wide layout and hands it to the host", async () => {
  const seen: Array<string | undefined> = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: undefined,
    artifactNamespace: "gen-layout",
    onArtifact: (_artifact, _html, context) => {
      seen.push(context.layout);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  await tool.execute("call-1", { title: "Board", html: "<p>a</p>", layout: "wide" });
  await tool.execute("call-2", { title: "Card", html: "<p>b</p>" });
  await tool.execute("call-3", { title: "Card", html: "<p>c</p>", layout: "column" });
  await assert.rejects(tool.execute("call-4", { title: "X", html: "<p>d</p>", layout: "huge" }), /layout/iu);
  assert.deepEqual(seen, ["wide", "column", "column"]);
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
  // The body the preview would cut out of this document links to javascript:, though a <textarea> hides it as written.
  const hidden = '<textarea><body><a href="javascript:alert(1)">x</a></body></textarea>';
  await assert.rejects(tool.execute("hidden", { title: "X", html: hidden }), /javascript:/iu);
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

test("render_artifact shows a visual whose script will not compile and says which line stops it", async () => {
  const shown: string[] = [];
  const extension = createGenerativeUiExtension({
    workspaceRoot: undefined,
    artifactNamespace: "gen-scripts",
    onArtifact: (_artifact, html) => {
      shown.push(html);
    },
  });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  const text = (result: Awaited<ReturnType<typeof tool.execute>>) =>
    result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

  const broken = [
    "<h1>Growth</h1>",
    "<canvas id=\"c\"></canvas>",
    "<script>",
    "const data = [1, 2, 3];",
    "draw(data;",
    "</script>",
    "<script type=\"application/json\">{not js</script>",
    "<template><script>also not run (</script></template>",
    "<script>window.ok = true;</script>",
  ].join("\n");
  const result = text(await tool.execute("call-1", { title: "Growth", html: broken }));
  // The visual is still shown; the model learns what stops and where.
  assert.deepEqual(shown, [broken]);
  assert.match(result, /Script check: 1 problem found\. The visual is shown as written\./u);
  assert.match(result, /The script starting on line 3 will not run: .+ \(line 5\)\. The reader sees the visual without anything that script draws/u);
  assert.match(result, /call render_artifact again with the same title/u);

  const clean = text(await tool.execute("call-2", { title: "Fixed", html: broken.replace("draw(data;", "draw(data);") }));
  assert.match(clean, /Script check: no problems found; all 2 inline scripts compile\./u);

  const plain = text(await tool.execute("call-3", { title: "Plain", html: "<p>No scripts here</p>" }));
  assert.doesNotMatch(plain, /Script check/u);

  const module = text(await tool.execute("call-4", { title: "Module", html: "<script type=\"module\">import x from './x.js'</script>" }));
  assert.match(module, /Not checked: 1 module script \(type="module"\)\./u);
  // Nothing was compiled, so the report does not claim that every script compiles.
  assert.match(module, /Script check: no problems found; no inline script could be compiled here\./u);
  assert.doesNotMatch(module, /compiles/u);
});

test("a script in another language is not compiled as JavaScript, and one named JavaScript is", async () => {
  const extension = createGenerativeUiExtension({ workspaceRoot: undefined, artifactNamespace: "gen-language", onArtifact: () => {} });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  const run = async (html: string) =>
    (await tool.execute("call", { title: "Lang", html })).content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const vbscript = await run('<script language="vbscript">MsgBox "hi"</script>');
  assert.doesNotMatch(vbscript, /Script check/u);
  const javascript = await run('<script language="JavaScript">draw(;</script>');
  assert.match(javascript, /Script check: 1 problem found/u);
  // A type, even an empty one, wins over the language.
  const typed = await run('<script type="" language="vbscript">draw(;</script>');
  assert.match(typed, /Script check: 1 problem found/u);
});

test("a JavaScript type with parameters is reported as a script that will not run, while padding and case still run", async () => {
  const extension = createGenerativeUiExtension({ workspaceRoot: undefined, artifactNamespace: "gen-type-params", onArtifact: () => {} });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  const run = async (html: string) =>
    (await tool.execute("call", { title: "Types", html })).content.map((part) => (part.type === "text" ? part.text : "")).join("");
  // Chromium runs neither of these, so the reader sees nothing they draw.
  const charset = await run('<p>Chart</p>\n<script type="text/javascript; charset=utf-8">draw();</script>');
  assert.match(charset, /Script check: 1 problem found/u);
  assert.match(charset, /The script on line 2 will not run: its type "text\/javascript; charset=utf-8" has parameters/u);
  const version = await run('<script type="application/javascript;version=1">draw();</script>');
  assert.match(version, /Script check: 1 problem found/u);
  // A browser trims and lowercases the type before matching, so these run and are compiled.
  const padded = await run('<script type=" TEXT/JavaScript ">draw();</script>');
  assert.match(padded, /Script check: no problems found; its inline script compiles\./u);
  // A data block whose type has parameters is still a data block.
  const data = await run('<script type="application/json; charset=utf-8">{"a": 1}</script>');
  assert.doesNotMatch(data, /Script check/u);
});

test("a script error after a line or paragraph separator names the line an editor shows", async () => {
  const extension = createGenerativeUiExtension({ workspaceRoot: undefined, artifactNamespace: "gen-separator", onArtifact: () => {} });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  // HTML counts only the newlines, so the error is on the visual's line 3; JavaScript also breaks at U+2028 and U+2029.
  const html = ["<p>Chart</p>", "<script>const label = 'a\u2028b\u2029c';", "draw(;</script>"].join("\n");
  const result = await tool.execute("call-1", { title: "Sep", html });
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.match(text, /The script starting on line 2 will not run: .+ \(line 3\)\./u);
});

test("a script error inside an SVG is reported, and nothing the script says runs while it is checked", async () => {
  const extension = createGenerativeUiExtension({ workspaceRoot: undefined, artifactNamespace: "gen-svg", onArtifact: () => {} });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  const marker = `__aiden_script_check_${Date.now()}`;
  const html = `<svg viewBox="0 0 10 10"><script>globalThis.${marker} = 1;</script><script>let = = 2</script></svg>`;
  const result = await tool.execute("call-1", { title: "Dial", html });
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  assert.match(text, /Script check: 1 problem found/u);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined);
});

test("a long script error is cut short without splitting a character", async () => {
  const extension = createGenerativeUiExtension({ workspaceRoot: undefined, artifactNamespace: "gen-long-error", onArtifact: () => {} });
  const tool = extension.tools?.[0];
  assert.ok(tool);
  // V8 quotes the identifier, so the message is long and made of characters two code units wide.
  const result = await tool.execute("call-1", { title: "Long", html: `<script>let a = 1 a${"𝑥".repeat(150)}</script>` });
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const message = /will not run: (.*) \(line 1\)/u.exec(text)?.[1] ?? "";
  assert.match(message, /^Unexpected identifier 'a𝑥+…$/u);
  assert.ok(message.length <= 200);
  assert.doesNotMatch(message, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});
