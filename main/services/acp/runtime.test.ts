import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ToolCallUpdate } from "@agentclientprotocol/sdk";
import { Type, type AssistantMessage, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";

import { AcpHostRegistry } from "./host.js";
import { AcpHarnessRuntime } from "./runtime.js";
import { AcpSessionStore } from "./session-store.js";
import { GenerationTimelineProjector } from "../generation-timeline.js";
import { AidenRemoteStreamService } from "../aiden-remote-streams.js";
import {
  FAKE_FLASH,
  FAKE_PRO,
  FakeLauncher,
  RecordingHost,
  fakeAgentEnv,
  fakeDefinition,
  readAgentLog,
  tempDir,
  waitForAgentLog,
  transcript,
  userMessage,
} from "./test-support.js";

interface Harness {
  runtime: AcpHarnessRuntime;
  hosts: AcpHostRegistry;
  launcher: FakeLauncher;
  env: ReturnType<typeof fakeAgentEnv>;
  store: AcpSessionStore;
  dir: string;
}

function harness(dir = tempDir(), env = fakeAgentEnv(dir), options = {}): Harness {
  const hosts = new AcpHostRegistry();
  const launcher = new FakeLauncher(env);
  const store = new AcpSessionStore(path.join(dir, "sessions.json"));
  const runtime = new AcpHarnessRuntime(fakeDefinition, launcher, hosts, store, options);
  return { runtime, hosts, launcher, env, store, dir };
}

async function turn(
  h: Harness,
  messages: Message[],
  options: { chatId?: string; signal?: AbortSignal; reasoning?: "low" | "high"; model?: typeof FAKE_FLASH; tools?: Parameters<typeof transcript>[2] } = {},
): Promise<AssistantMessage> {
  const stream = h.runtime.stream(options.model ?? FAKE_FLASH, transcript(messages, "Be helpful.", options.tools ?? []), {
    sessionId: options.chatId ?? "chat-1",
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  });
  return stream.result();
}

function text(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
}

test("300 growing diff updates keep timeline and Remote journal publications bounded and finish with the last line counts", async (t) => {
  const h = harness();
  t.after(() => h.runtime.close());
  const host = new RecordingHost("chat-1", h.dir);
  const remote = new AidenRemoteStreamService({ now: Date.now, cancel: () => true, approve: () => true });
  const owner = remote.create("device-1", "stream-1", "chat-1", "turn-1");
  let publishes = 0;
  let running = 0;
  const timeline = new GenerationTimelineProjector("stream-1", (snapshot) => {
    publishes += 1;
    owner.owner.send("chat:timeline", { streamId: "stream-1", timeline: snapshot });
  });
  host.activity = {
    started: (id, name, args) => timeline.toolStarted(id, name, args),
    running: (id) => { running += 1; timeline.toolRunning(id); },
    finished: (id, status, details) => timeline.toolFinished(id, status as "completed" | "failed", details),
  };
  h.hosts.register(host);
  const result = await turn(h, [userMessage("stream-diff")]);
  assert.equal(result.stopReason, "stop");
  assert.equal(publishes, 3);
  assert.equal(running, 31, "initial running update plus 30 checkpoints");
  assert.equal(remote.snapshot().streams[0]?.events.filter((event) => event.type === "timeline").length, 3);
  const step = timeline.snapshot().steps[0];
  assert.ok(step?.kind === "tool");
  assert.equal(step.status, "completed");
  assert.deepEqual(step.lineChanges, { additions: 300, deletions: 1 });
});

type ScriptEntry = (ToolCallUpdate & { sessionUpdate: "tool_call" | "tool_call_update" }) | { permission: ToolCallUpdate };
function toolScript(entries: ScriptEntry[]): Message {
  return userMessage(`tool-updates:${JSON.stringify(entries)}`);
}

test("two interleaved tools checkpoint independently and never skip completed or failed after a silent chunk", async (t) => {
  const h = harness();
  t.after(() => h.runtime.close());
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const entries: ScriptEntry[] = [
    { sessionUpdate: "tool_call", toolCallId: "a", title: "Edit A", kind: "edit", status: "in_progress" },
    { sessionUpdate: "tool_call", toolCallId: "b", title: "Edit B", kind: "edit", status: "in_progress" },
  ];
  for (let chunk = 1; chunk <= 11; chunk += 1) {
    for (const id of ["a", "b"]) entries.push({ sessionUpdate: "tool_call_update", toolCallId: id, rawInput: { chunk } });
  }
  entries.push(
    { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" },
    { sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed" },
  );
  assert.equal((await turn(h, [toolScript(entries)])).stopReason, "stop");
  assert.deepEqual(host.activities.filter((event) => event.event === "running").map((event) => event.id.split(":").pop()), ["a", "b", "a", "b"]);
  assert.deepEqual(host.activities.filter((event) => event.event === "finished").map((event) => event.status), ["completed", "failed"]);
});

test("status, title, text output, and raw output changes report before the next checkpoint", async (t) => {
  const h = harness();
  t.after(() => h.runtime.close());
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const update = (fields: ToolCallUpdate): ScriptEntry => ({ sessionUpdate: "tool_call_update", ...fields });
  const message = toolScript([
    { sessionUpdate: "tool_call", toolCallId: "a", title: "Command", kind: "execute", status: "pending" },
    update({ toolCallId: "a", rawInput: { chunk: 1 } }),
    update({ toolCallId: "a", status: "in_progress" }),
    update({ toolCallId: "a", rawInput: { chunk: 2 } }),
    update({ toolCallId: "a", title: "Command progressing" }),
    update({ toolCallId: "a", content: [{ type: "content", content: { type: "text", text: "stdout" } }] }),
    update({ toolCallId: "a", rawOutput: { stdout: "result" } }),
    update({ toolCallId: "a", status: "completed" }),
  ]);
  assert.equal((await turn(h, [message])).stopReason, "stop");
  assert.deepEqual(host.activities.map((event) => event.event), ["started", "running", "running", "running", "running", "finished"]);
});

test("a permission after a skipped update still presents its card; subagent and MCP classification are preserved", async (t) => {
  const h = harness();
  t.after(() => h.runtime.close());
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const approval = toolScript([
    { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", kind: "edit", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "edit", rawInput: { text: "partial" } },
    { permission: { toolCallId: "edit", title: "Edit", kind: "edit", locations: [{ path: path.join(h.dir, "notes.txt") }] } },
    { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" },
  ]);
  const reply = await turn(h, [approval]);
  assert.equal(host.approvals.length, 1);
  assert.deepEqual(host.approvals[0]?.paths, ["notes.txt"]);
  assert.equal(host.approvals[0]?.activityId, host.activities[0]?.id);
  assert.equal(host.activities[host.activities.length - 1]?.status, "completed");
  // Reuse a tool id on the following turn. Its checkpoint counter starts fresh.
  const next = toolScript([
    { sessionUpdate: "tool_call", toolCallId: "edit", title: "Edit", kind: "edit", status: "in_progress" },
    ...Array.from({ length: 9 }, (_, chunk): ScriptEntry => ({ sessionUpdate: "tool_call_update", toolCallId: "edit", rawInput: { chunk } })),
    { sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" },
  ]);
  const start = host.activities.length;
  await turn(h, [approval, reply, next]);
  assert.deepEqual(host.activities.slice(start).map((event) => event.event), ["started", "running", "finished"]);

  const definition = { ...fakeDefinition, isSubagentCall: (update: ToolCallUpdate) => update._meta?.subagent === true };
  const runtime = new AcpHarnessRuntime(definition, h.launcher, h.hosts, h.store);
  t.after(() => runtime.close());
  const classified = toolScript([
    { sessionUpdate: "tool_call", toolCallId: "child", title: "Research", kind: "other", status: "in_progress", _meta: { subagent: true } },
    { sessionUpdate: "tool_call_update", toolCallId: "child", rawInput: { chunk: 1 } },
    { sessionUpdate: "tool_call_update", toolCallId: "child", status: "completed" },
    { sessionUpdate: "tool_call", toolCallId: "mcp", title: "MCP", kind: "other", status: "in_progress", _meta: { is_mcp_tool_call: true } },
    { sessionUpdate: "tool_call_update", toolCallId: "mcp", status: "failed" },
  ]);
  const boundary = host.activities.length;
  await turn({ ...h, runtime }, [classified]);
  const events = host.activities.slice(boundary);
  assert.equal(events[0]?.toolName, "agent_subagents");
  assert.deepEqual(events.map((event) => event.event), ["started", "running", "finished"]);
  assert.equal(events[2]?.status, "completed");
});

test("a turn without a registered host is refused instead of running an unsupervised agent", async () => {
  const h = harness();
  const result = await turn(h, [userMessage("echo:hi")]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /only in ordinary desktop chats/u);
  assert.equal(h.launcher.launches.length, 0);
  await h.runtime.close();
});

test("streams the agent's reply and thinking, and reuses one session per chat", async () => {
  const h = harness();
  const host = new RecordingHost("chat-1", h.dir);
  const unregister = h.hosts.register(host);
  const first = await turn(h, [userMessage("think:hello there")]);
  assert.equal(first.stopReason, "stop");
  assert.equal(text(first), "hello there");
  assert.ok(first.content.some((block) => block.type === "thinking"));
  assert.equal(first.usage.input, 10);
  assert.equal(first.usage.output, 5);

  const second = await turn(h, [userMessage("think:hello there"), first, userMessage("history")]);
  assert.equal(text(second), "prompts:2");
  assert.equal(h.launcher.launches.filter((launch) => launch.purpose === "chat").length, 1);
  unregister();
  await h.runtime.close();
});

test("selects the native model for Aiden's model and reasoning level, and the mode for the permission", async () => {
  const h = harness();
  const host = new RecordingHost("chat-1", h.dir);
  host.currentPermission = "full";
  h.hosts.register(host);
  await turn(h, [userMessage("echo:a")], { reasoning: "high" });
  await turn(h, [userMessage("echo:a"), userMessage("echo:b")], { model: FAKE_PRO });
  const sets = readAgentLog(h.env).filter((entry) => entry.method === "setConfigOption");
  assert.deepEqual(
    sets.map((entry) => `${entry.configId}=${entry.value}`),
    ["mode=yolo", "model=fake-flash-high", "model=fake-pro"],
  );
  await h.runtime.close();
});

test("a rewound conversation starts a fresh session that receives a reconstruction", async () => {
  const h = harness();
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const first = await turn(h, [userMessage("echo:one")]);
  await turn(h, [userMessage("echo:one"), first, userMessage("echo:two")]);
  // The user edits the first message: history no longer matches the session.
  const edited = await turn(h, [userMessage("echo:changed"), userMessage("prompt-dump")]);
  const dump = JSON.parse(text(edited)) as Array<{ type: string; resource?: { text: string } }>;
  assert.equal(dump[0]?.type, "resource");
  assert.match(dump[0]?.resource?.text ?? "", /echo:changed/u);
  assert.match(dump[0]?.resource?.text ?? "", /# Instructions from Aiden\n\nBe helpful\./u);
  assert.equal(host.notices.length, 1);
  assert.equal(readAgentLog(h.env).filter((entry) => entry.method === "newSession").length, 2);
  await h.runtime.close();
});

test("native edits go through Aiden's file callback, after Aiden's approval in Ask mode", async () => {
  const h = harness();
  const file = path.join(h.dir, "notes.txt");
  writeFileSync(file, "old line\n");
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const result = await turn(h, [userMessage(`edit:${file}`)]);
  assert.equal(text(result), "edit applied");
  assert.equal(readFileSync(file, "utf8"), "new line\n");
  assert.equal(host.approvals.length, 1);
  assert.equal(host.approvals[0]?.kind, "file_change");
  assert.deepEqual(host.approvals[0]?.paths, ["notes.txt"]);
  assert.equal(host.approvals[0]?.warning, "Prompt injection risk");
  assert.equal(host.approvals[0]?.offersAlways, true);
  // The approval names the activity row it belongs to.
  assert.equal(host.approvals[0]?.activityId, host.activities.find((activity) => activity.event === "started")?.id);
  assert.equal(host.writes.length, 1);
  const started = host.activities.find((activity) => activity.event === "started");
  assert.equal(started?.toolName, "edit_file");
  assert.deepEqual(started?.args, { path: "notes.txt" });
  const finished = host.activities.find((activity) => activity.event === "finished");
  assert.equal(finished?.status, "completed");
  assert.deepEqual(finished?.details, { kind: "file_line_changes", version: 1, additions: 1, deletions: 1 });
  await h.runtime.close();
});

test("a denied approval leaves the file untouched and marks the activity blocked", async () => {
  const h = harness();
  const file = path.join(h.dir, "notes.txt");
  writeFileSync(file, "old line\n");
  const host = new RecordingHost("chat-1", h.dir);
  host.approvalAnswer = "reject";
  h.hosts.register(host);
  const result = await turn(h, [userMessage(`edit:${file}`)]);
  assert.equal(text(result), "edit denied");
  assert.equal(readFileSync(file, "utf8"), "old line\n");
  assert.ok(host.activities.some((activity) => activity.event === "finished" && activity.status === "blocked"));
  await h.runtime.close();
});

test("read-only chats refuse native commands without asking", async () => {
  const h = harness();
  const file = path.join(h.dir, "notes.txt");
  writeFileSync(file, "old line\n");
  const host = new RecordingHost("chat-1", h.dir);
  host.currentPermission = "read-only";
  h.hosts.register(host);
  const execResult = await turn(h, [userMessage("exec")]);
  assert.equal(text(execResult), "command denied");
  assert.equal(host.approvals.length, 0);
  await h.runtime.close();
});

test("file callbacks are confined to the chat's folder", async () => {
  const h = harness();
  const outside = path.join(tempDir(), "secret.txt");
  writeFileSync(outside, "secret");
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const result = await turn(h, [userMessage(`read:${outside}`)]);
  assert.match(text(result), /^read refused:/u);
  await h.runtime.close();
});

test("agent questions delivered as permission requests reach Aiden's question prompt", async () => {
  const h = harness();
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const result = await turn(h, [userMessage("question")]);
  assert.equal(text(result), "answer:blue");
  assert.equal(host.questions[0]?.title, "Which color?");
  assert.deepEqual(host.questions[0]?.options.map((option) => option.label), ["Red", "Blue"]);
  assert.equal(host.approvals.length, 0);
  await h.runtime.close();
});

test("bridged Aiden tools run through the Pi tool loop and the same ACP prompt resumes", async () => {
  const h = harness();
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const tools = [{ name: "lookup", description: "Look something up", parameters: Type.Object({ value: Type.String() }) }];
  const first = await turn(h, [userMessage("bridge:aiden_lookup")], { tools });
  assert.equal(first.stopReason, "toolUse");
  const call = first.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  assert.equal(call.name, "lookup");
  assert.deepEqual(call.arguments, { value: "hello" });
  // MCP activity is not duplicated as a native row: Aiden renders the real call.
  assert.equal(host.activities.length, 0);

  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: "found it" }],
    isError: false,
    timestamp: Date.now(),
  };
  const second = await turn(h, [userMessage("bridge:aiden_lookup"), first, result], { tools });
  assert.equal(second.stopReason, "stop");
  assert.equal(text(second), "bridge:found it");
  assert.equal(readAgentLog(h.env).filter((entry) => entry.method === "prompt").length, 1);
  const listed = readAgentLog(h.env).find((entry) => entry.method === "bridgeTools");
  assert.deepEqual(listed?.names, ["aiden_lookup"]);
  await h.runtime.close();
});

test("Stop cancels the agent's turn and reports an aborted message", async () => {
  const h = harness();
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const controller = new AbortController();
  const pending = turn(h, [userMessage("slow")], { signal: controller.signal });
  await waitForAgentLog(h.env, (entry) => entry.method === "prompt" && entry.text === "slow");
  controller.abort();
  const result = await pending;
  assert.equal(result.stopReason, "aborted");
  assert.ok(readAgentLog(h.env).some((entry) => entry.method === "cancel"));
  await h.runtime.close();
});

test("a crashed agent fails the turn, and the next turn starts a new process", async () => {
  const h = harness();
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const crashed = await turn(h, [userMessage("crash")]);
  assert.equal(crashed.stopReason, "error");
  assert.match(crashed.errorMessage ?? "", /stopped unexpectedly/u);
  const next = await turn(h, [userMessage("echo:again")]);
  assert.equal(text(next), "again");
  assert.equal(h.launcher.launches.filter((launch) => launch.purpose === "chat").length, 2);
  await h.runtime.close();
});

test("after a restart the chat resumes its saved agent session instead of rebuilding", async () => {
  const dir = tempDir();
  const env = fakeAgentEnv(dir);
  const first = harness(dir, env);
  first.hosts.register(new RecordingHost("chat-1", dir));
  const reply = await turn(first, [userMessage("echo:one")]);
  await first.runtime.close();
  await first.store.flush();

  const second = harness(dir, env);
  const host = new RecordingHost("chat-1", dir);
  second.hosts.register(host);
  const result = await turn(second, [userMessage("echo:one"), reply, userMessage("history")]);
  assert.equal(text(result), "prompts:2");
  assert.ok(readAgentLog(env).some((entry) => entry.method === "resumeSession" && entry.known === true));
  assert.equal(host.notices.length, 0);
  await second.runtime.close();
});

test("at most the configured number of idle sessions stay alive", async () => {
  const h = harness(undefined, undefined, { maxLiveSessions: 1 });
  h.hosts.register(new RecordingHost("chat-a", h.dir));
  h.hosts.register(new RecordingHost("chat-b", h.dir));
  await turn(h, [userMessage("echo:a")], { chatId: "chat-a" });
  await turn(h, [userMessage("echo:b")], { chatId: "chat-b" });
  assert.equal(h.runtime.liveCount, 1);
  assert.equal(h.launcher.processes.filter((process) => process.alive).length, 1);
  await h.runtime.close();
});

function toolResultFor(message: AssistantMessage, textValue: string): ToolResultMessage {
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall", "expected a tool call");
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: textValue }],
    isError: false,
    timestamp: Date.now(),
  };
}

const lookupTools = [{ name: "lookup", description: "Look something up", parameters: Type.Object({ value: Type.String() }) }];

test("a message sent mid-turn is answered in the same turn, then not repeated", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const first = await turn(h, [userMessage("bridge:aiden_lookup")], { tools: lookupTools });
  const result = toolResultFor(first, "found it");
  const steer = userMessage("echo:steer this way");
  const second = await turn(h, [userMessage("bridge:aiden_lookup"), first, result, steer], { tools: lookupTools });
  assert.equal(text(second), "bridge:found itsteer this way");
  assert.equal(readAgentLog(h.env).filter((entry) => entry.method === "prompt").length, 2);
  const third = await turn(
    h,
    [userMessage("bridge:aiden_lookup"), first, result, steer, second, userMessage("prompt-dump")],
    { tools: lookupTools },
  );
  assert.doesNotMatch(text(third), /steer this way/u, "the agent already answered it; nothing is replayed");
  await h.runtime.close();
});

test("a continuation stops when the folder's permission can no longer be enforced natively", async () => {
  const dir = tempDir();
  const env = fakeAgentEnv(dir);
  const hosts = new AcpHostRegistry();
  const definition = {
    ...fakeDefinition,
    // An agent whose only approval mode Aiden cannot select.
    nativeModeFor: (permission: string) => (permission === "full" ? "yolo" : "unsupported-mode"),
  };
  const runtime = new AcpHarnessRuntime(definition, new FakeLauncher(env), hosts, new AcpSessionStore(path.join(dir, "s.json")));
  const host = new RecordingHost("chat-1", dir);
  host.currentPermission = "full";
  hosts.register(host);
  const h = { runtime, hosts, launcher: new FakeLauncher(env), env, store: new AcpSessionStore(path.join(dir, "x.json")), dir };
  const first = await turn(h, [userMessage("bridge:aiden_lookup")], { tools: lookupTools });
  assert.equal(first.stopReason, "toolUse");
  host.currentPermission = "ask";
  const second = await turn(h, [userMessage("bridge:aiden_lookup"), first, toolResultFor(first, "x")], { tools: lookupTools });
  assert.equal(second.stopReason, "error");
  assert.match(second.errorMessage ?? "", /approval mode/u);
  // session/cancel is a notification; give it a moment to reach the agent.
  for (let attempt = 0; attempt < 50 && !readAgentLog(env).some((entry) => entry.method === "cancel"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(readAgentLog(env).some((entry) => entry.method === "cancel"));
  await runtime.close();
});

test("a bridged call that arrives after the stream ended is shown on the next stream", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const messages: Message[] = [userMessage("bridge-late:aiden_lookup")];
  const first = await turn(h, messages, { tools: lookupTools });
  assert.equal(first.stopReason, "toolUse");
  messages.push(first, toolResultFor(first, "one"));
  const second = await turn(h, messages, { tools: lookupTools });
  assert.equal(second.stopReason, "toolUse", "the late call is announced instead of killing the session");
  messages.push(second, toolResultFor(second, "two"));
  const third = await turn(h, messages, { tools: lookupTools });
  assert.equal(text(third), "bridge-late:one,two");
  assert.equal(h.launcher.launches.length, 1);
  await h.runtime.close();
});

test("a tool result arriving after the agent gave up does not hang the next stream", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const messages: Message[] = [userMessage("bridge-abandon:aiden_lookup")];
  const first = await turn(h, messages, { tools: lookupTools });
  assert.equal(first.stopReason, "toolUse");
  await new Promise((resolve) => setTimeout(resolve, 600));
  messages.push(first, toolResultFor(first, "late"));
  const second = await turn(h, messages, { tools: lookupTools });
  assert.equal(second.stopReason, "stop");
  await h.runtime.close();
});

test("after a clean Stop the same agent session continues", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const controller = new AbortController();
  const pending = turn(h, [userMessage("slow")], { signal: controller.signal });
  await waitForAgentLog(h.env, (entry) => entry.method === "prompt" && entry.text === "slow");
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.stopReason, "aborted");
  const next = await turn(h, [userMessage("slow"), stopped, userMessage("history")]);
  assert.equal(text(next), "prompts:2");
  assert.equal(h.launcher.launches.length, 1);
  await h.runtime.close();
});

test("eviction never closes a session that is mid-turn", async () => {
  const h = harness(undefined, undefined, { maxLiveSessions: 1 });
  h.hosts.register(new RecordingHost("chat-a", h.dir));
  h.hosts.register(new RecordingHost("chat-b", h.dir));
  const controller = new AbortController();
  const busy = turn(h, [userMessage("slow")], { chatId: "chat-a", signal: controller.signal });
  await waitForAgentLog(h.env, (entry) => entry.method === "prompt" && entry.text === "slow");
  await turn(h, [userMessage("echo:b")], { chatId: "chat-b" });
  assert.equal(h.runtime.liveCount, 2);
  controller.abort();
  assert.equal((await busy).stopReason, "aborted");
  await h.runtime.close();
});

test("writes the user did not approve are refused in Ask, and every write is refused when read-only", async () => {
  const h = harness();
  const file = path.join(h.dir, "notes.txt");
  writeFileSync(file, "old line\n");
  const host = new RecordingHost("chat-1", h.dir);
  h.hosts.register(host);
  const asked = await turn(h, [userMessage(`write:${file}`)]);
  assert.match(text(asked), /^write refused:/u);
  host.currentPermission = "read-only";
  const readOnly = await turn(h, [userMessage(`write:${file}`), asked, userMessage(`write:${file}`)]);
  assert.match(text(readOnly), /^write refused:/u);
  assert.equal(readFileSync(file, "utf8"), "old line\n");
  host.currentPermission = "full";
  const full = await turn(h, [userMessage(`write:${file}`), asked, userMessage(`write:${file}`), readOnly, userMessage(`write:${file}`)]);
  assert.equal(text(full), "wrote");
  await h.runtime.close();
});

test("a message sent mid-turn stays owed across further tool calls and is answered", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const messages: Message[] = [userMessage("bridge-late:aiden_lookup")];
  const first = await turn(h, messages, { tools: lookupTools });
  messages.push(first, toolResultFor(first, "one"), userMessage("echo:STEER"));
  const second = await turn(h, messages, { tools: lookupTools });
  assert.equal(second.stopReason, "toolUse", "the agent's second call still arrives");
  messages.push(second, toolResultFor(second, "two"));
  const third = await turn(h, messages, { tools: lookupTools });
  assert.match(text(third), /STEER$/u);
  assert.equal(readAgentLog(h.env).filter((entry) => entry.method === "prompt").length, 2);
  await h.runtime.close();
});

test("text the agent streams after Stop never appears in the next reply", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const controller = new AbortController();
  const pending = turn(h, [userMessage("slow")], { signal: controller.signal });
  await waitForAgentLog(h.env, (entry) => entry.method === "prompt" && entry.text === "slow");
  controller.abort();
  const stopped = await pending;
  const next = await turn(h, [userMessage("slow"), stopped, userMessage("echo:fresh")]);
  assert.equal(text(next), "fresh");
  await h.runtime.close();
});

test("a message owed when the turn is stopped is delivered exactly once by the next turn", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const messages: Message[] = [userMessage("bridge-late:aiden_lookup")];
  const first = await turn(h, messages, { tools: lookupTools });
  messages.push(first, toolResultFor(first, "one"), userMessage("echo:STEER"));
  const second = await turn(h, messages, { tools: lookupTools });
  assert.equal(second.stopReason, "toolUse");
  // Pi's loop stops without returning the second result (as after a Stop):
  // the next user message arrives instead.
  messages.push(second, userMessage("prompt-dump"));
  const third = await turn(h, messages, { tools: lookupTools });
  const delivered = text(third).split("STEER").length - 1;
  assert.equal(delivered, 1, text(third));
  await h.runtime.close();
});

test("signing out stops every agent process and refuses new ones until it finishes", async () => {
  const h = harness();
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  await turn(h, [userMessage("echo:before")]);
  assert.equal(h.runtime.liveCount, 1);
  const reopen = await h.runtime.closeAdmission();
  assert.equal(h.runtime.liveCount, 0);
  assert.ok(h.launcher.processes.every((process) => !process.alive));
  const refused = await turn(h, [userMessage("echo:during")]);
  assert.match(refused.errorMessage ?? "", /signing out/u);
  await assert.rejects(h.runtime.discoverModels(h.dir), /signing out/u);
  reopen();
  const after = await turn(h, [userMessage("echo:after")]);
  assert.equal(text(after), "after");
  await h.runtime.close();
});

test("a bridged tool that outlives its timeout ends the agent's turn cleanly; its late result starts a fresh prompt", async () => {
  const h = harness(undefined, undefined, { toolTimeoutMs: 200 });
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const messages: Message[] = [userMessage("bridge:aiden_lookup")];
  const first = await turn(h, messages, { tools: lookupTools });
  assert.equal(first.stopReason, "toolUse");
  // The bridge timeout cancels the agent's turn; wait for that, not a clock.
  await waitForAgentLog(h.env, (entry) => entry.method === "cancel");
  messages.push(first, toolResultFor(first, "late result"));
  const second = await turn(h, messages, { tools: lookupTools });
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.doesNotMatch(text(second), /did not finish in time/u, "the abandoned turn's text is not mixed in");
  assert.equal(readAgentLog(h.env).filter((entry) => entry.method === "prompt").length, 2);
  await h.runtime.close();
});

test("sign-out waits for a catalog launch that was still starting and stops it", async () => {
  const dir = tempDir();
  const env = fakeAgentEnv(dir);
  const inner = new FakeLauncher(env);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowLauncher = {
    async launch(purpose: Parameters<FakeLauncher["launch"]>[0], cwd: string) {
      await gate;
      return inner.launch(purpose, cwd);
    },
  };
  const runtime = new AcpHarnessRuntime(fakeDefinition, slowLauncher, new AcpHostRegistry(), new AcpSessionStore(path.join(dir, "s.json")));
  const discovery = runtime.discoverModels(dir).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closing = runtime.closeAdmission();
  release();
  const reopen = await closing;
  assert.ok(inner.processes.length <= 1);
  assert.ok(inner.processes.every((process) => !process.alive), "no process from before sign-out survives");
  assert.match(String(await discovery), /signing out/u);
  reopen();
  await runtime.close();
});

test("an idle agent between turns cannot read the chat's files", async () => {
  const h = harness();
  const file = path.join(h.dir, "notes.txt");
  writeFileSync(file, "private");
  h.hosts.register(new RecordingHost("chat-1", h.dir));
  const reply = await turn(h, [userMessage(`read-later:${file}`)]);
  assert.equal(text(reply), "scheduled");
  await waitForAgentLog(h.env, (entry) => entry.method === "lateRead");
  assert.equal(readAgentLog(h.env).find((entry) => entry.method === "lateRead")?.ok, false);
  await h.runtime.close();
});
