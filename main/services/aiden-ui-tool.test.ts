import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseChatUiVisualV1 } from "../../renderer/shared/aiden-ui/visual.js";
import type { ChatUiVisualV1 } from "../../renderer/shared/aiden-ui/types.js";
import { createRenderUiTool, RENDER_UI_TOOL_NAME } from "./aiden-ui-tool.js";
import { piRuntimeReplayPolicy } from "./pi-runtime-tool.js";

const markup = (name: string) =>
  readFileSync(new URL(`../../renderer/shared/aiden-ui/fixtures/markup/${name}.aum`, import.meta.url), "utf8");

function tool(existingChatUiCount = 0) {
  const presented: { visual: ChatUiVisualV1; toolCallId: string }[] = [];
  const instance = createRenderUiTool({
    namespace: "gen-1",
    existingChatUiCount,
    onUiVisual: (visual, context) => {
      presented.push({ visual, toolCallId: context.toolCallId });
    },
  });
  return { instance, presented };
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

test("render_ui compiles markup into a storable visual and never echoes it back", async () => {
  const { instance, presented } = tool();
  assert.equal(instance.name, RENDER_UI_TOOL_NAME);
  assert.equal(piRuntimeReplayPolicy(instance), "never");
  const result = await instance.execute("toolu_1", { title: "Q3 revenue", layout: "wide", markup: markup("dashboard") });
  assert.equal(presented.length, 1);
  const visual = presented[0]!.visual;
  assert.ok(parseChatUiVisualV1(visual));
  assert.equal(visual.title, "Q3 revenue");
  assert.equal(visual.layout, "wide");
  assert.equal(presented[0]!.toolCallId, "toolu_1");
  assert.match(text(result), /Rendered visual "Q3 revenue"/u);
  assert.doesNotMatch(text(result), /<Stat|<Data/u);
});

test("repairs come back to the model as diagnostics it can act on", async () => {
  const { instance, presented } = tool();
  const result = await instance.execute("toolu_1", { title: "Velocity", markup: markup("broken") });
  assert.equal(presented.length, 1);
  assert.match(text(result), /unknown_element: <div>/u);
  assert.match(text(result), /unknown_prop: Stat\.onClick/u);
});

test("markup that yields nothing, bad layouts, and bad titles are rejected", async () => {
  const { instance, presented } = tool();
  await assert.rejects(instance.execute("a", { title: "Empty", markup: "  " }), /no visual/u);
  await assert.rejects(instance.execute("b", { title: "X", layout: "huge", markup: "<Visual><Text>a</Text></Visual>" }), /layout/u);
  await assert.rejects(instance.execute("c", { title: " padded", markup: "<Visual><Text>a</Text></Visual>" }));
  await assert.rejects(instance.execute("d", { title: "X" }), /markup/u);
  assert.equal(presented.length, 0);
});

test("a revision with the same title keeps the first visual's id and position", async () => {
  const { instance, presented } = tool();
  await instance.execute("first", { title: "Board", markup: "<Visual><Text>one</Text></Visual>" });
  await instance.execute("second", { title: "Board", markup: "<Visual><Text>two</Text></Visual>" });
  await instance.execute("third", { title: "Other", markup: "<Visual><Text>three</Text></Visual>" });
  assert.equal(presented[0]!.visual.id, presented[1]!.visual.id);
  assert.notEqual(presented[0]!.visual.id, presented[2]!.visual.id);
  assert.deepEqual(presented.map((entry) => entry.toolCallId), ["first", "first", "third"]);
  assert.match(presented[1]!.visual.fallbackText, /two/u);
});

test("per-response and per-chat caps hold", async () => {
  const { instance } = tool();
  for (let index = 0; index < 8; index += 1) {
    await instance.execute(`call-${index}`, { title: `V${index}`, markup: "<Visual><Text>a</Text></Visual>" });
  }
  await assert.rejects(instance.execute("call-9", { title: "V9", markup: "<Visual><Text>a</Text></Visual>" }), /8 visuals/u);
  const nearlyFull = tool(59).instance;
  await nearlyFull.execute("x", { title: "Last", markup: "<Visual><Text>a</Text></Visual>" });
  await assert.rejects(nearlyFull.execute("y", { title: "Over", markup: "<Visual><Text>a</Text></Visual>" }), /60/u);
});
