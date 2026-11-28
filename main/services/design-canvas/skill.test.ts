import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGenerativeUiHostLibrary } from "../generative-ui-host-libraries.js";
import { LOAD_TOOLS_TOOL_NAME, ON_DEMAND_TOOL_NAMES } from "../on-demand-tools.js";
import {
  createDesignCanvasTools,
  DESIGN_MODE_PROMPT_SECTION,
  LIVE_DESIGN_MD_PROMPT_BULLET,
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
  const section = designModePromptSection(true, "limited");
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
  for (const text of [designModePromptSection(true, "live"), designModePromptSection(false, "live"), aidenDesignSkill(true).instructions]) {
    const named = new Set(text.match(/\bcanvas_[a-z_]+|\bdesign_(?:system|app)\b|\bload_tools\b/gu) ?? []);
    assert.ok(named.has("design_app"), "the live text teaches design_app");
    for (const name of named) assert.ok(offered.has(name), `${name} is named but not offered`);
    assert.match(text, /\bvariantOf\b/u);
  }
});

test("3b: the prompt section is today's unless the turn offers design_app", () => {
  assert.equal(designModePromptSection(false), DESIGN_MODE_PROMPT_SECTION);
  assert.doesNotMatch(designModePromptSection(true, "limited"), /design_app/u, "Windows, or design_app excluded");
  assert.ok(designModePromptSection(true, "live").includes(LIVE_DESIGN_MD_PROMPT_BULLET), "the DESIGN.md bullet, verbatim");
  assert.ok(!designModePromptSection(false, "live").includes(LIVE_DESIGN_MD_PROMPT_BULLET));
  assert.ok(designModePromptSection(false, "live").includes(LIVE_APP_PROMPT_MARKER));
  // JSX comment pins wait for Phase 4's source mapping.
  assert.doesNotMatch(designModePromptSection(true, "live"), /data-aiden-comment/u);
});

test("3b: the live skill claims no check DESIGN.md's linter doesn't make", () => {
  assert.equal(aidenDesignSkill(false), AIDEN_DESIGN_SKILL);
  const live = aidenDesignSkill(true);
  assert.equal(live.name, AIDEN_DESIGN_SKILL.name);
  assert.doesNotMatch(live.instructions, /data-aiden-comment/u, "app frames take frame comments only");
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

// ── 3d (S114): the HTML mockup path ──

test("3d: flag off, the skill still teaches the HTML method but no longer promises the tokens offer", () => {
  const text = AIDEN_DESIGN_SKILL.instructions;
  assert.doesNotMatch(text, /a design-mode note lists them once/u);
  assert.doesNotMatch(text, /design\/specimen\.html/u);
  for (const kept of [
    "design/tokens.css holds the tokens as CSS variables, with a dark look. With no design system, pick a small set of tokens, write them to design/tokens.css and say which.",
    'Put data-aiden-src="<file>"',
    "call canvas_inspect for a picture after the first version",
    '<script type="application/aiden-tweaks">',
    "Checklist:",
    'Add data-aiden-comment="<commentId>"',
  ]) {
    assert.ok(text.includes(kept), kept);
  }
  assert.match(AIDEN_DESIGN_SKILL.description, /workspace HTML file/u);
});

test("3d: flag on, the skill never teaches design/ HTML pages and explains scaffold", () => {
  const live = aidenDesignSkill(true);
  for (const phrase of [/design\/tokens\.css/u, /workspace HTML/u, /data-aiden-tweaks|application\/aiden-tweaks/u]) {
    assert.doesNotMatch(live.instructions, phrase);
    assert.doesNotMatch(live.description, phrase);
  }
  assert.match(live.instructions, /design_app scaffold/u);
  assert.match(live.instructions, /src\/routes\//u);
  assert.match(live.instructions, /don't ask first with ask_user_question/u);
  assert.match(live.instructions, /Checklist:/u, "the craft guidance stays");
});
