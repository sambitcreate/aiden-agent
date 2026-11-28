// Measures how much of a forked session's input a child agent's compactions
// account for, offline against Pi's faux provider (no network, no real model).
//
//   node --import tsx scripts/measure-child-compaction-share.mts
//
// A parent of ten turns (each 10,000-character reply) forks a child that must
// compact before its first request. Every faux request's prompt tokens
// (input + cache read + cache write, at four characters a token) are logged and
// labelled a summary when the request is the summarization call. The parent
// that forked the child is modelled as resending its whole context at each of
// its user turns. Prints JSON with each request, the summary total, the child
// total, the modelled parent and the two shares.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createModels,
  type Api,
  type AssistantMessage,
  type Model,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SubagentRuntimeRegistry } from "../main/services/subagents/child-agent-runtime.ts";

const PROVIDER = "aiden-phase7-child-surface";
const MODEL = "phase7-child";
const SYSTEM_PROMPT = "Continue the fork faithfully.";
const SUMMARY_REQUEST = /context summarization assistant/u;

const user = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});
const assistantText = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: PROVIDER,
  model: MODEL,
  usage: {
    input: 950,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 960,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

function historicalTurns(prefix: string, count: number, chars: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < count; i++)
    messages.push(
      user(`${prefix}-request-${i}`),
      assistantText(`${prefix}-answer-${i}-${"x".repeat(chars)}`),
    );
  return messages;
}

const core = createFauxCore({ provider: PROVIDER, models: [{ id: MODEL, contextWindow: 32_768 }] });
core.setResponses(
  Array.from(
    { length: 50 },
    () => async (context: unknown) =>
      SUMMARY_REQUEST.test(JSON.stringify(context))
        ? fauxAssistantMessage("## Goal\nCHILD-909 summary")
        : fauxAssistantMessage(`continued CHILD-909 ${"y".repeat(8_000)}`),
  ),
);

const requests: Array<{ kind: "summary" | "turn"; promptTokens: number; order: number }> = [];
let order = 0;
const streamSimple: typeof core.streamSimple = (model, context, options) => {
  const stream = core.streamSimple(model, context, options);
  const kind = SUMMARY_REQUEST.test(JSON.stringify(context)) ? "summary" : "turn";
  const index = order++;
  void stream.result().then((result) => {
    requests.push({
      kind,
      promptTokens: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
      order: index,
    });
  });
  return stream;
};

const model = core.getModel() as Model<Api>;
const runtime = {
  models: createModels(),
  provider: {
    id: model.provider,
    kind: "openai",
    label: "Replay provider",
    baseUrl: model.baseUrl,
    models: [model.id],
    needsKey: false,
    deployment: "hosted",
  },
  model,
  apiKey: undefined,
  headers: undefined,
  streams: { streamSimple },
};
const initialMessages = [
  ...historicalTurns("child-surface", 10, 10_000),
  user("Child first task must preserve CHILD-909 before provider I/O"),
];

const registry = new SubagentRuntimeRegistry();
const child = registry.create({
  authority: { generationId: "measure", chatId: "measure-child", workspaceId: "measure-workspace" },
  groupId: "measure-child",
  runtime: runtime as Parameters<SubagentRuntimeRegistry["create"]>[0]["runtime"],
  thinkingLevel: "off",
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
  initialMessages,
});
await child.prompt("Continue CHILD-909.");
await registry.shutdown(1_000);
await new Promise((resolve) => setTimeout(resolve, 50));
requests.sort((a, b) => a.order - b.order);

// The parent sent each of its turns with the whole context so far.
let parentTokens = 0;
let chars = SYSTEM_PROMPT.length;
for (const message of initialMessages) {
  chars += JSON.stringify((message as UserMessage | AssistantMessage).content).length;
  if (message.role === "user") parentTokens += Math.ceil(chars / 4);
}
const summaryTokens = requests
  .filter((request) => request.kind === "summary")
  .reduce((total, request) => total + request.promptTokens, 0);
const childTokens = requests.reduce((total, request) => total + request.promptTokens, 0);
console.log(
  JSON.stringify(
    {
      requests,
      summaryTokens,
      childTokens,
      parentTokens,
      sessionTokens: childTokens + parentTokens,
      shareOfChild: summaryTokens / childTokens,
      shareOfSession: summaryTokens / (childTokens + parentTokens),
    },
    null,
    2,
  ),
);
