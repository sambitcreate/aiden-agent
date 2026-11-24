import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGenerativeUiHostLibrary } from "../generative-ui-host-libraries.js";
import { LOAD_TOOLS_TOOL_NAME, ON_DEMAND_TOOL_NAMES } from "../on-demand-tools.js";
import { createDesignCanvasTools, DESIGN_MODE_PROMPT_SECTION, designModePromptSection } from "./canvas-tools.js";
import { DesignMdReader } from "./design-md/reader.js";
import { createDesignSystemTool } from "./design-md/tool.js";
import { AIDEN_DESIGN_SKILL } from "./skill.js";
import { DesignCanvasStore, DesignChatCanvases } from "./store.js";

test("every canvas tool the design skill and prompt name is a tool Aiden actually gets", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-skill-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const tools = createDesignCanvasTools({
    chatId: "chat-1",
    workspaceRoot: base,
    store: new DesignChatCanvases({ store: new DesignCanvasStore({ root: () => base }), workspaceIdOf: async () => "ws-1" }),
    broadcast: () => undefined,
  });
  const offered = new Set(tools.map((tool) => tool.name));
  const named = new Set(
    [AIDEN_DESIGN_SKILL.instructions, DESIGN_MODE_PROMPT_SECTION].flatMap((text) => text.match(/\bcanvas_[a-z_]+/gu) ?? []),
  );
  assert.ok(named.size >= 3, "the skill teaches the canvas tools by name");
  for (const name of named) assert.ok(offered.has(name), `${name} is named but not offered`);
});

test("every tool the flag-on prompt section names is one a flag-on turn offers", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-skill-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const tools = [
    ...createDesignCanvasTools({
      chatId: "chat-1",
      workspaceRoot: base,
      store: new DesignChatCanvases({ store: new DesignCanvasStore({ root: () => base }), workspaceIdOf: async () => "ws-1" }),
      broadcast: () => undefined,
    }),
    createDesignSystemTool({ workspaceRoot: base, reader: new DesignMdReader() }),
  ];
  const offered = new Set(tools.map((tool) => tool.name));
  const section = designModePromptSection(true);
  const named = new Set(section.match(/\bcanvas_[a-z_]+|\bdesign_system\b/gu) ?? []);
  assert.ok(named.has("design_system"), "the flag-on section teaches design_system");
  for (const name of named) assert.ok(offered.has(name), `${name} is named but not offered`);
  assert.equal(designModePromptSection(false), DESIGN_MODE_PROMPT_SECTION, "the flag-off section is today's");
});

test("every library the design skill offers is one a design page can load", async () => {
  const listed = AIDEN_DESIGN_SKILL.instructions.match(/\/__aiden\/lib\/<name>: ([^\n]+)\./u)?.[1]?.split(", ") ?? [];
  assert.ok(listed.length > 0);
  for (const name of listed) {
    assert.ok(await readGenerativeUiHostLibrary(name), `${name} is offered but not served`);
  }
});

test("an on-demand tool the design skill tells Aiden to call comes with how to load it", () => {
  const words = new Set(AIDEN_DESIGN_SKILL.instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/gu) ?? []);
  const onDemand = [...words].filter((word) => ON_DEMAND_TOOL_NAMES.has(word));
  assert.ok(onDemand.length > 0, "the skill names design_mode, which is on demand");
  assert.ok(words.has(LOAD_TOOLS_TOOL_NAME), `${onDemand.join(", ")} is on demand, so the skill must say to load it with ${LOAD_TOOLS_TOOL_NAME}`);
});
