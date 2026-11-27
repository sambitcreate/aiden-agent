import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGenerativeUiHostLibrary } from "../generative-ui-host-libraries.js";
import { LOAD_TOOLS_TOOL_NAME, ON_DEMAND_TOOL_NAMES } from "../on-demand-tools.js";
import {
  createDesignCanvasTools,
  DESIGN_MD_PROMPT_BULLET,
  DESIGN_MODE_PROMPT_SECTION,
  designModePromptSection,
  LIVE_APP_PROMPT_MARKER,
} from "./canvas-tools.js";
import { createDesignAppTool } from "./app-server/app-tool.js";
import { DesignMdReader } from "./design-md/reader.js";
import { createDesignSystemTool } from "./design-md/tool.js";
import { AIDEN_DESIGN_SKILL, AIDEN_DESIGN_SKILL_ID, aidenDesignSkill, designCanvasSkills } from "./skill.js";
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

// ── 3b (S86): the live prompt and skill ──

test("3b: every tool the live prompt and skill name is one a flag-on turn with design_app offers", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-skill-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const tools = [
    ...createDesignCanvasTools({
      chatId: "chat-1",
      workspaceRoot: base,
      store: new DesignChatCanvases({ store: new DesignCanvasStore({ root: () => base }), workspaceIdOf: async () => "ws-1" }),
      broadcast: () => undefined,
      designLive: true,
      apps: { snapshot: async (workspaceId) => ({ workspaceId, target: "none", apps: [], candidates: [], chosen: [] }) },
    }),
    createDesignSystemTool({ workspaceRoot: base, reader: new DesignMdReader() }),
    createDesignAppTool({
      workspaceId: "ws-1",
      chatId: "chat-1",
      permission: "ask",
      owner: () => null as never,
      stillAvailable: async () => true,
      servers: {} as never,
    }),
  ];
  const offered = new Set([...tools.map((tool) => tool.name), LOAD_TOOLS_TOOL_NAME]);
  for (const text of [designModePromptSection(true, true), designModePromptSection(false, true), aidenDesignSkill(true).instructions]) {
    const named = new Set(text.match(/\bcanvas_[a-z_]+|\bdesign_(?:system|app)\b|\bload_tools\b/gu) ?? []);
    assert.ok(named.has("design_app"), "the live text teaches design_app");
    for (const name of named) assert.ok(offered.has(name), `${name} is named but not offered`);
    assert.match(text, /\bvariantOf\b/u);
  }
});

test("3b: the prompt section is today's unless the turn offers design_app", () => {
  assert.equal(designModePromptSection(false), DESIGN_MODE_PROMPT_SECTION);
  assert.equal(designModePromptSection(true), `${DESIGN_MODE_PROMPT_SECTION}\n${DESIGN_MD_PROMPT_BULLET}`, "Windows, or design_app excluded");
  assert.equal(designModePromptSection(true, false), designModePromptSection(true));
  assert.doesNotMatch(designModePromptSection(true, false), /design_app/u);
  assert.ok(designModePromptSection(true, true).includes(DESIGN_MD_PROMPT_BULLET), "the DESIGN.md bullet, verbatim");
  assert.ok(!designModePromptSection(false, true).includes(DESIGN_MD_PROMPT_BULLET));
  assert.ok(designModePromptSection(false, true).includes(LIVE_APP_PROMPT_MARKER));
  // JSX comment pins wait for Phase 4's source mapping.
  assert.doesNotMatch(designModePromptSection(true, true), /data-aiden-comment/u);
});

test("3b: the live skill keeps the HTML method for no web app, and claims no check DESIGN.md's linter doesn't make", () => {
  assert.equal(aidenDesignSkill(false), AIDEN_DESIGN_SKILL);
  const live = aidenDesignSkill(true);
  assert.equal(live.name, AIDEN_DESIGN_SKILL.name);
  const [liveSections, noWebApp] = live.instructions.split(/\nNo web app:/u);
  assert.ok(noWebApp, "a No web app section");
  assert.doesNotMatch(liveSections!, /data-aiden-comment/u, "app frames take frame comments only in 3b");
  assert.ok(noWebApp!.includes("design/tokens.css"), "the HTML method follows");
  for (const claim of [/(?<!not )\bchecks? (?:the )?(?:Motion|Voice)/u, /(?<!not )\bresolves? (?:an? )?@file#fragment/u, /\bmotion (?:group|tokens?) (?:is|are) (?:checked|linted)/iu]) {
    assert.doesNotMatch(live.instructions, claim);
  }
});

test("3b: the registry lists the live skill with the live flag, today's without, and none with design mode off", () => {
  const [live] = designCanvasSkills({ designMode: true, designLive: true });
  assert.equal(live?.stableId, AIDEN_DESIGN_SKILL_ID);
  assert.equal(live?.instructions, aidenDesignSkill(true).instructions);
  const [today] = designCanvasSkills({ designMode: true, designLive: false });
  assert.equal(today?.instructions, AIDEN_DESIGN_SKILL.instructions);
  assert.deepEqual(designCanvasSkills({ designMode: false, designLive: true }), []);
});
