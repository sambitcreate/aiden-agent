import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  LOAD_TOOLS_TOOL_NAME,
  MAX_ON_DEMAND_ROUTING_CHARACTERS,
  ON_DEMAND_DECLARED_ENTRY,
  createOnDemandTools,
  declareOnDemandSummary,
  onDemandDeclaredNames,
  onDemandDeclaredOfBranch,
  onDemandToolSummary,
} from "./on-demand-tools.js";
import { createRenderUiTool } from "./aiden-ui-tool.js";
import { createDesignModeTool } from "./design-canvas/design-mode-tool.js";
import { createDesignCanvasTools } from "./design-canvas/canvas-tools.js";
import { estimateStaticContextTokens } from "./generation-context.js";
import { createGenerativeUiExtensionRuntime } from "./generative-ui-extension.js";

function fixtureTool(name: string, description: string, calls: string[] = []): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({ value: Type.Optional(Type.String({ description: "x".repeat(400) })) }),
    execute: async () => {
      calls.push(name);
      return { content: [{ type: "text", text: `${name} ran` }], details: null };
    },
  };
}

const ON_DEMAND = new Set(["render_chart", "make_schedule"]);

test("a run declares everyday tools first and a loaded tool only from the next step, then runs it", async () => {
  const calls: string[] = [];
  const tools = [
    fixtureTool("read_file", "Read a file.", calls),
    fixtureTool("render_chart", "Render an interactive chart inline. Use it for numbers.", calls),
    fixtureTool("make_schedule", "Create a scheduled task.", calls),
  ];
  const loading = createOnDemandTools(tools, ON_DEMAND)!;
  const declaredPerRequest: string[][] = [];
  const faux = createFauxCore({ models: [{ id: "m" }] });
  const observe = (context: { messages: readonly unknown[] }) => {
    declaredPerRequest.push(getCurrentTools(context.messages as never).map(({ name }) => name));
  };
  faux.setResponses([
    (context) => {
      observe(context);
      return fauxAssistantMessage([fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["render_chart"] })], { stopReason: "toolUse" });
    },
    (context) => {
      observe(context);
      return fauxAssistantMessage([fauxToolCall("render_chart", { value: "1,2,3" })], { stopReason: "toolUse" });
    },
    (context) => {
      observe(context);
      return fauxAssistantMessage("done");
    },
  ]);
  const agent = new Agent({
    initialState: { model: faux.getModel(), systemPrompt: "Base", tools: loading.initialTools([]) },
    streamFn: faux.streamSimple,
    prepareNextTurnWithContext: async ({ context }) => {
      const next = await loading.prepare(context);
      return next === context ? undefined : { context: next };
    },
  });
  await agent.prompt("Chart these numbers");

  assert.deepEqual(declaredPerRequest[0], ["read_file", LOAD_TOOLS_TOOL_NAME]);
  assert.ok(declaredPerRequest[1]!.includes("render_chart"));
  assert.ok(!declaredPerRequest[1]!.includes("make_schedule"), "only the requested tool is declared");
  assert.deepEqual(calls, ["render_chart"]);
});

test("a chat that already loaded or called an on-demand tool declares it from the start of the next run", () => {
  const tools = [fixtureTool("read_file", "Read."), fixtureTool("render_chart", "Chart."), fixtureTool("make_schedule", "Schedule.")];
  const loading = createOnDemandTools(tools, ON_DEMAND)!;
  const history = (name: string, args: Parameters<typeof fauxToolCall>[1]): AgentMessage[] => [
    { role: "user", content: "hi", timestamp: 1 },
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
  ];
  const names = (messages: AgentMessage[]) => loading.initialTools(messages).map(({ name }) => name);
  assert.deepEqual(names([]), ["read_file", LOAD_TOOLS_TOOL_NAME]);
  assert.deepEqual(names(history(LOAD_TOOLS_TOOL_NAME, { names: ["make_schedule"] })), ["read_file", LOAD_TOOLS_TOOL_NAME, "make_schedule"]);
  // A direct call that failed as "not found" still marks the tool as wanted.
  assert.deepEqual(names(history("render_chart", {})), ["read_file", LOAD_TOOLS_TOOL_NAME, "render_chart"]);
  // Names outside this chat's admitted inventory are never declared.
  assert.deepEqual(names(history(LOAD_TOOLS_TOOL_NAME, { names: ["run_anything"] })), ["read_file", LOAD_TOOLS_TOOL_NAME]);
});

test("the next run declares loaded tools in the same order the last request of the run did", async () => {
  // Loaded against catalog order: make_schedule first, then render_chart.
  const tools = [fixtureTool("read_file", "Read."), fixtureTool("render_chart", "Chart."), fixtureTool("make_schedule", "Schedule.")];
  const loading = createOnDemandTools(tools, ON_DEMAND)!;
  let lastDeclared: string[] = [];
  const faux = createFauxCore({ models: [{ id: "m" }] });
  const step = (message: ReturnType<typeof fauxAssistantMessage>) => (context: { messages: readonly unknown[] }) => {
    lastDeclared = getCurrentTools(context.messages as never).map(({ name }) => name);
    return message;
  };
  faux.setResponses([
    step(fauxAssistantMessage([fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["make_schedule"] })], { stopReason: "toolUse" })),
    step(fauxAssistantMessage([fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["render_chart"] })], { stopReason: "toolUse" })),
    step(fauxAssistantMessage("done")),
  ]);
  const agent = new Agent({
    initialState: { model: faux.getModel(), systemPrompt: "Base", tools: loading.initialTools([]) },
    streamFn: faux.streamSimple,
    prepareNextTurnWithContext: async ({ context }) => {
      const next = await loading.prepare(context);
      return next === context ? undefined : { context: next };
    },
  });
  await agent.prompt("Plan and chart");

  assert.deepEqual(lastDeclared, ["read_file", LOAD_TOOLS_TOOL_NAME, "make_schedule", "render_chart"]);
  assert.deepEqual(loading.initialTools(agent.state.messages).map(({ name }) => name), lastDeclared);
});

test("loading cannot grant a tool the chat was not given, or one a host exclusion removed", async () => {
  const tools = [fixtureTool("read_file", "Read."), fixtureTool("render_chart", "Chart.")];
  const loading = createOnDemandTools(tools, ON_DEMAND)!;
  await assert.rejects(loading.loader.execute("a", { names: ["make_schedule"] }), /Not loadable here: make_schedule\. Load one of: render_chart\./u);
  await assert.rejects(loading.loader.execute("b", { names: [] }), /Load one of: render_chart/u);
  assert.match(JSON.stringify(await loading.loader.execute("c", { names: ["render_chart"] })), /Loaded render_chart/u);
  const asked = { messages: [fauxAssistantMessage([fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["render_chart"] })])] };
  const withoutLoader = { ...asked, tools: [tools[0]!] };
  assert.equal(await loading.prepare(withoutLoader), withoutLoader);
  assert.equal(createOnDemandTools([fixtureTool("read_file", "Read.")], ON_DEMAND), undefined);
});

test("the held-back tools cost a one-line catalog entry instead of their full declaration", () => {
  const tools = [
    fixtureTool("read_file", "Read."),
    ...Array.from({ length: 10 }, (_, index) => fixtureTool(`tool_${index}`, `Does thing ${index}. ${"Long guidance. ".repeat(40)}`)),
  ];
  const loading = createOnDemandTools(tools, new Set(tools.slice(1).map(({ name }) => name)))!;
  const all = estimateStaticContextTokens({ contextWindow: 200_000, systemPrompt: "", tools });
  const initial = estimateStaticContextTokens({ contextWindow: 200_000, systemPrompt: "", tools: loading.initialTools([]) });
  assert.ok(initial * 5 < all, `${initial} tokens up front instead of ${all}`);
  assert.match(loading.loader.description, /- tool_3: Does thing 3\./u);
});

test("catalog summaries keep the first sentence and stay short", () => {
  assert.equal(onDemandToolSummary("Render a chart.  Use it often."), "Render a chart.");
  const long = onDemandToolSummary(`${"word ".repeat(40)}end.`);
  assert.ok(long.length <= 90);
  assert.ok(long.endsWith("…"));
});

test("a tool's own routing line reaches the load_tools catalog whole, with when to use it", () => {
  const routing =
    "Keep a live page in this workspace; use when the person wants something to come back to, like a pull request board or a release checklist.";
  assert.ok(routing.length > 90);
  const declared = declareOnDemandSummary(fixtureTool("keep_page", `Pages persist. ${"Long guidance. ".repeat(20)}`), routing);
  const loading = createOnDemandTools([fixtureTool("read_file", "Read."), declared], new Set(["keep_page"]))!;
  assert.ok(loading.loader.description.includes(`- keep_page: ${routing}`));
  assert.throws(() => declareOnDemandSummary(fixtureTool("a", "A."), "  "), /catalog line/iu);
  assert.throws(
    () => declareOnDemandSummary(fixtureTool("b", "B."), "x".repeat(MAX_ON_DEMAND_ROUTING_CHARACTERS + 1)),
    /catalog line/iu,
  );
});

test("visual and design tools tell the model when to load them, without a cut-off line", () => {
  const tools = [
    fixtureTool("read_file", "Read."),
    createRenderUiTool({ namespace: "ui", existingChatUiCount: 0, onUiVisual: () => undefined }),
    createDesignModeTool({ isOn: async () => false, requestEnter: async () => "declined", exit: async () => undefined, canvasToolNames: [] }),
  ];
  const loading = createOnDemandTools(tools, new Set(["render_ui", "design_mode"]))!;
  const lines = loading.loader.description.split("\n").filter((line) => /^- (render_ui|design_mode):/u.test(line));
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /use when/u);
    assert.doesNotMatch(line, /…$/u);
  }
  assert.match(lines.find((line) => line.startsWith("- design_mode"))!, /app screens|several directions/u);
});

test("a design chat starts with the everyday canvas tools and loads the page and duplicate tools when it needs them", () => {
  const canvas = createDesignCanvasTools({ chatId: "chat-1", workspaceRoot: "/workspace", store: {} as never, broadcast: () => undefined });
  const loading = createOnDemandTools([fixtureTool("read_file", "Read."), ...canvas])!;
  const first = loading.initialTools([]).map((tool) => tool.name);
  for (const everyday of ["canvas_read", "canvas_place_frame", "canvas_update_frame", "canvas_build", "canvas_inspect"]) {
    assert.ok(first.includes(everyday), `${everyday} is declared from the start`);
  }
  assert.ok(!first.includes("canvas_page") && !first.includes("canvas_duplicate"));
  const lines = loading.loader.description.split("\n").filter((line) => /^- canvas_(page|duplicate):/u.test(line));
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotMatch(line, /…$/u, "each has a whole catalog line");

  const loaded: AgentMessage[] = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: LOAD_TOOLS_TOOL_NAME, arguments: { names: ["canvas_duplicate"] } }],
    } as never,
  ];
  const later = loading.initialTools(loaded).map((tool) => tool.name);
  assert.ok(later.includes("canvas_duplicate") && !later.includes("canvas_page"));
});

test("a preloaded tool is declared from the start without a load, and a chat mode that preloads every turn keeps one tool list", () => {
  const tools = [fixtureTool("read_file", "Read."), fixtureTool("render_chart", "Chart."), fixtureTool("make_schedule", "Schedule.")];
  const loading = createOnDemandTools(tools, ON_DEMAND)!;
  const names = (messages: AgentMessage[], preload?: string[], before?: string[]) =>
    loading.initialTools(messages, preload, before).map(({ name }) => name);
  assert.deepEqual(names([], ["render_chart"]), ["read_file", LOAD_TOOLS_TOOL_NAME, "render_chart"]);
  // A name the chat was not given is never declared by preloading it, nor by an old record.
  assert.deepEqual(names([], ["run_anything"], ["run_anything"]), ["read_file", LOAD_TOOLS_TOOL_NAME]);

  // A design chat preloads render_chart every turn; it then loads make_schedule.
  const history: AgentMessage[] = [
    { role: "user", content: "plan", timestamp: 1 },
    fauxAssistantMessage([fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["make_schedule"] })], { stopReason: "toolUse" }),
  ];
  const first = names([], ["render_chart"]);
  const second = names(history, ["render_chart"], first.slice(2));
  assert.deepEqual(second, ["read_file", LOAD_TOOLS_TOOL_NAME, "render_chart", "make_schedule"]);
});

test("a chat whose next turn preloads tools, and the turn after that, never reorder or drop what was declared before", () => {
  const tools = [
    fixtureTool("read_file", "Read."),
    fixtureTool("render_ui", "UI."),
    fixtureTool("render_artifact", "HTML."),
    fixtureTool("visualize_guide", "Guide."),
    fixtureTool("make_schedule", "Schedule."),
  ];
  const visual = ["render_ui", "render_artifact", "visualize_guide"];
  const loading = createOnDemandTools(tools, new Set([...visual, "make_schedule"]))!;
  // Each turn reads the list the previous turn recorded on the journal branch, as a chat run does.
  const branch: { type: string; customType?: string; data?: unknown }[] = [];
  const turn = (messages: AgentMessage[], preload: string[] = []) => {
    const declared = loading.initialTools(messages, preload, onDemandDeclaredOfBranch(branch));
    branch.push({ type: "message" }, { type: "custom", customType: ON_DEMAND_DECLARED_ENTRY, data: { names: onDemandDeclaredNames(declared, loading.onDemand) } });
    return declared.map(({ name }) => name);
  };
  const isPrefix = (earlier: string[], later: string[]) => earlier.every((name, index) => later[index] === name);

  // Turn 1 loads make_schedule; turn 2 is a /visualize turn that calls only render_ui; turn 3 is an ordinary turn.
  const loaded: AgentMessage[] = [
    { role: "user", content: "plan", timestamp: 1 },
    fauxAssistantMessage([fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["make_schedule"] })], { stopReason: "toolUse" }),
  ];
  const before = turn(loaded);
  const visualizing = turn(loaded, visual);
  const called = [...loaded, fauxAssistantMessage([fauxToolCall("render_ui", {})], { stopReason: "toolUse" })];
  const after = turn(called);

  assert.deepEqual(before, ["read_file", LOAD_TOOLS_TOOL_NAME, "make_schedule"]);
  assert.ok(isPrefix(before, visualizing), `the /visualize turn only adds at the end: ${visualizing.join(", ")}`);
  for (const name of visual) assert.ok(visualizing.includes(name), `${name} is declared without a load`);
  assert.deepEqual(after, visualizing, "the turn after keeps every preloaded tool where it was, called or not");

  // A chat with no record yet (its first journaled turn) still never puts a preload before a used tool.
  const fresh = loading.initialTools(called, visual).map(({ name }) => name);
  assert.ok(fresh.indexOf("make_schedule") < fresh.indexOf("render_ui"));
});

test("loading a visual tool answers with its guide in the same step, and a guide part two loaded tools share comes once", async () => {
  const { extension } = createGenerativeUiExtensionRuntime({ onArtifact: () => true, onUiVisual: () => true });
  const loading = createOnDemandTools([fixtureTool("read_file", "Read."), ...extension.tools!])!;
  const answer = async (names: string[]) => {
    const result = await loading.loader.execute("load", { names });
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
  const ui = await answer(["render_ui"]);
  assert.match(ui, /^Loaded render_ui\./u);
  assert.match(ui, /Aiden UI catalog \(render_ui\)/u, "the component catalog comes with render_ui");
  assert.match(ui, /do not call visualize_guide/u);
  assert.doesNotMatch(ui, /## HTML structure/u, "raw HTML guidance is not render_ui's");

  const html = await answer(["render_artifact"]);
  assert.match(html, /## HTML structure/u);
  assert.match(html, /## Charts/u);
  assert.doesNotMatch(html, /Aiden UI catalog/u);

  const both = await answer(["render_ui", "render_artifact"]);
  assert.equal(both.split("do not call visualize_guide").length, 2, "the guide's lead-in appears once");
  assert.match(both, /Aiden UI catalog[\s\S]*## HTML structure/u);

  // Loading a tool without a guide answers as before.
  const guide = await answer(["visualize_guide"]);
  assert.equal(guide, "Loaded visualize_guide. Call it from your next step.");
});

test("a load answer leaves out the guide parts the chat has already read, and its lead-in goes with what is sent", async () => {
  const { extension } = createGenerativeUiExtensionRuntime({ onArtifact: () => true, onUiVisual: () => true });
  const loading = createOnDemandTools([fixtureTool("read_file", "Read."), ...extension.tools!])!;
  const guideTool = extension.tools!.find((tool) => tool.name === "visualize_guide")!;
  const read = await guideTool.execute("guide", { modules: ["design", "html"] });
  const messages: AgentMessage[] = [
    { role: "user", content: "chart it", timestamp: 1 },
    fauxAssistantMessage([fauxToolCall("visualize_guide", { modules: ["design", "html"] })], { stopReason: "toolUse" }),
    { role: "toolResult", toolCallId: "guide", toolName: "visualize_guide", content: read.content, isError: false, timestamp: 2 },
  ];
  const answer = async (names: string[]) => {
    const result = await loading.loader.execute("load", { names });
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
  const before = loading.initialTools(messages).map((tool) => tool.name);
  await loading.prepare({ messages, tools: loading.initialTools(messages) });
  assert.ok(before.includes("visualize_guide"));

  const html = await answer(["render_artifact"]);
  assert.doesNotMatch(html, /## Design/u, "the design part was read through visualize_guide");
  assert.doesNotMatch(html, /## HTML structure/u);
  assert.match(html, /## Charts[\s\S]*## Interactivity/u, "the parts not read yet still come");
  assert.equal(html.split("do not call visualize_guide").length, 2, "one lead-in before the parts sent");

  // Once the load answer itself is in the chat, loading render_artifact again repeats nothing.
  const later: AgentMessage[] = [
    ...messages,
    fauxAssistantMessage([fauxToolCall(LOAD_TOOLS_TOOL_NAME, { names: ["render_artifact"] })], { stopReason: "toolUse" }),
    { role: "toolResult", toolCallId: "load", toolName: LOAD_TOOLS_TOOL_NAME, content: [{ type: "text", text: html }], isError: false, timestamp: 3 },
  ];
  await loading.prepare({ messages: later, tools: loading.initialTools(later) });
  assert.equal(await answer(["render_artifact"]), "Loaded render_artifact. Call it from your next step.");
  // render_ui's catalog was never read, so it still comes with its lead-in.
  assert.match(await answer(["render_ui"]), /do not call visualize_guide[\s\S]*Aiden UI catalog \(render_ui\)/u);
});
