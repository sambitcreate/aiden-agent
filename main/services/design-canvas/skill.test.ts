import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readGenerativeUiHostLibrary } from "../generative-ui-host-libraries.js";
import { LOAD_TOOLS_TOOL_NAME, ON_DEMAND_TOOL_NAMES } from "../on-demand-tools.js";
import { createDesignCanvasTools, DESIGN_MODE_PROMPT_SECTION } from "./canvas-tools.js";
import { AIDEN_DESIGN_SKILL } from "./skill.js";
import { DesignCanvasStore } from "./store.js";

test("every canvas tool the design skill and prompt name is a tool Aiden actually gets", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-skill-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const tools = createDesignCanvasTools({
    chatId: "chat-1",
    workspaceRoot: base,
    store: new DesignCanvasStore({ root: () => base }),
    broadcast: () => undefined,
  });
  const offered = new Set(tools.map((tool) => tool.name));
  const named = new Set(
    [AIDEN_DESIGN_SKILL.instructions, DESIGN_MODE_PROMPT_SECTION].flatMap((text) => text.match(/\bcanvas_[a-z_]+/gu) ?? []),
  );
  assert.ok(named.size >= 3, "the skill teaches the canvas tools by name");
  for (const name of named) assert.ok(offered.has(name), `${name} is named but not offered`);
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
