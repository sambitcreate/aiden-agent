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

test("a visual whose data reads come back empty says so in the result", async () => {
  const { instance, presented } = tool();
  const clean = await instance.execute("toolu_1", { title: "Q3 revenue", markup: markup("dashboard") });
  assert.doesNotMatch(text(clean), /Visual check/u);

  const typo = markup("dashboard").replace("$data.totals[$metric]", "$data.totls[$metric]").replace("len($data.byRegion)", "$byRegion");
  const result = await instance.execute("toolu_2", { title: "Q3 revenue typo", markup: typo });
  // The visual still shows; the model learns which reads draw nothing.
  assert.equal(presented.length, 2);
  assert.match(text(result), /Visual check/u);
  assert.match(text(result), /\$data\.totls is always empty: the data has no "totls" field \(it has "totals", "byRegion"\)/u);
  assert.match(text(result), /\$byRegion is not a <Data> value or a state key/u);
  assert.match(text(result), /render_ui again with the same title/u);
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
  const first = await instance.execute("first", { title: "Board", markup: "<Visual><Text>one</Text></Visual>" });
  const second = await instance.execute("second", { title: "Board", markup: "<Visual><Text>two</Text></Visual>" });
  await instance.execute("third", { title: "Other", markup: "<Visual><Text>three</Text></Visual>" });
  assert.doesNotMatch(text(first), /Replaced/u);
  assert.match(text(second), /Replaced the visual "Board" in place/u, "Aiden hears that the redraw replaced the first");
  assert.equal(presented[0]!.visual.id, presented[1]!.visual.id);
  assert.notEqual(presented[0]!.visual.id, presented[2]!.visual.id);
  assert.deepEqual(presented.map((entry) => entry.toolCallId), ["first", "first", "third"]);
  assert.match(presented[1]!.visual.fallbackText, /two/u);
});

test("edits redraw a visual drawn earlier in this reply from the markup it was last drawn from, all or nothing", async () => {
  const { instance, presented } = tool();
  await instance.execute("first", { title: "Board", markup: "<Visual><Text>one</Text><Text>two</Text></Visual>" });
  const edited = await instance.execute("second", { title: "Board", edits: [{ old: "one", new: "uno" }] });
  assert.match(text(edited), /Replaced the visual "Board" in place/u);
  assert.match(presented[1]!.visual.fallbackText, /uno/u);
  assert.equal(presented[1]!.visual.id, presented[0]!.visual.id);
  // Later edits read the markup as the last redraw left it.
  await instance.execute("third", { title: "Board", edits: [{ old: "uno", new: "eins" }, { old: "two", new: "zwei" }] });
  assert.match(presented[2]!.visual.fallbackText, /eins[^]*zwei/u);

  await assert.rejects(
    instance.execute("miss", { title: "Board", edits: [{ old: "eins", new: "1" }, { old: "three", new: "3" }] }),
    /edits\[1\] old "three" was not found[^]*Nothing was changed/u,
  );
  await assert.rejects(
    instance.execute("twice", { title: "Board", edits: [{ old: "<Text>", new: "<Text tone=\"muted\">" }] }),
    /edits\[0\] old "<Text>" was found 2 times/u,
  );
  await assert.rejects(instance.execute("none", { title: "Other", edits: [{ old: "a", new: "b" }] }), /none is titled "Other"/u);
  await assert.rejects(
    instance.execute("both", { title: "Board", markup: "<Visual><Text>x</Text></Visual>", edits: [{ old: "a", new: "b" }] }),
    /either markup or edits/u,
  );
  // Nothing that failed was drawn, and a later edit still reads the last good markup.
  assert.equal(presented.length, 3);
  await instance.execute("fourth", { title: "Board", edits: [{ old: "zwei", new: "deux" }] });
  assert.match(presented[3]!.visual.fallbackText, /eins[^]*deux/u);
});

test("an edits redraw keeps the visual's wide layout unless it sets one, and says when the edits made the markup too long", async () => {
  const { instance, presented } = tool();
  await instance.execute("first", { title: "Board", layout: "wide", markup: "<Visual><Text>one</Text></Visual>" });
  await instance.execute("second", { title: "Board", edits: [{ old: "one", new: "uno" }] });
  assert.equal(presented[1]!.visual.layout, "wide");
  await instance.execute("third", { title: "Board", layout: "column", edits: [{ old: "uno", new: "eins" }] });
  assert.equal(presented[2]!.visual.layout, undefined, "an explicit column layout takes over");
  await instance.execute("fourth", { title: "Board", edits: [{ old: "eins", new: "un" }] });
  assert.equal(presented[3]!.visual.layout, undefined, "and is kept by the next edits");

  await assert.rejects(
    instance.execute("long", { title: "Board", edits: [{ old: "un", new: "x".repeat(400_000) }] }),
    /render_ui edits made the markup too long: 400,0\d\d characters, over the 400,000 a visual can be\. Nothing was drawn; send edits that remove more than they add/u,
  );
  assert.equal(presented.length, 4);
});

test("a same-title redraw the host does not show is not reported as drawn, and later edits read the shown markup", async () => {
  let show = true;
  const presented: ChatUiVisualV1[] = [];
  const instance = createRenderUiTool({
    namespace: "gen-1",
    existingChatUiCount: 0,
    onUiVisual: (visual) => {
      if (show) presented.push(visual);
      return show;
    },
  });
  await instance.execute("first", { title: "Board", markup: "<Visual><Text>one</Text></Visual>" });
  show = false;
  const hidden = text(await instance.execute("second", { title: "Board", edits: [{ old: "one", new: "two" }] }));
  assert.doesNotMatch(hidden, /Rendered|Replaced/u);
  assert.match(hidden, /could not show this redraw of the visual "Board"[^]*still sees the version drawn earlier/u);
  show = true;
  await instance.execute("third", { title: "Board", edits: [{ old: "one", new: "three" }] });
  assert.match(presented[1]!.fallbackText, /three/u);
});

test("render_ui edits refuse an old that matches twice once line breaks read alike, or that cuts a line break or emoji in two", async () => {
  const { instance, presented } = tool();
  await instance.execute("first", {
    title: "Mixed",
    markup: "<Visual><Text>a</Text>\r\n<Text>b</Text>\n<Text>a</Text>\n<Text>b</Text>\n<Text>x😀y</Text></Visual>",
  });
  // The exact LF text appears once, but the CRLF pair above it reads the same.
  await assert.rejects(
    instance.execute("twice", { title: "Mixed", edits: [{ old: "<Text>a</Text>\n<Text>b</Text>", new: "<Text>c</Text>" }] }),
    /edits\[0\] old "<Text>a<\/Text> <Text>b<\/Text>" was found 2 times with its line breaks and the markup's read alike; add surrounding text/u,
  );
  await assert.rejects(
    instance.execute("crlf", { title: "Mixed", edits: [{ old: "\n<Text>b</Text>\n<Text>a", new: "" }] }),
    /edits\[0\] old "<Text>b<\/Text> <Text>a" starts or ends between the \\r and \\n of a line break in the markup; include the whole line break/u,
  );
  await assert.rejects(
    instance.execute("emoji", { title: "Mixed", edits: [{ old: "\uDE00y", new: "!" }] }),
    /edits\[0\] old "\\ude00y" starts or ends inside a character made of two units, such as an emoji in the markup; include the whole character in old/u,
  );
  assert.equal(presented.length, 1, "no refused edit was drawn");
  // Taking in the whole emoji, or enough text to pick one place, works.
  await instance.execute("ok", {
    title: "Mixed",
    edits: [
      { old: "😀y", new: "!" },
      { old: "</Text>\n<Text>a</Text>\n", new: "</Text>\n<Text>c</Text>\n" },
    ],
  });
  assert.match(presented[1]!.visual.fallbackText, /a[^]*b[^]*c[^]*b[^]*x!/u);
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
