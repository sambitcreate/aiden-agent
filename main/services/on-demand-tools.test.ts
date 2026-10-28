import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, getCurrentTools } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  LOAD_TOOLS_TOOL_NAME,
  createOnDemandTools,
  onDemandToolSummary,
} from "./on-demand-tools.js";
import { estimateStaticContextTokens } from "./generation-context.js";

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
