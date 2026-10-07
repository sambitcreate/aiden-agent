import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Type, type AssistantMessage, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";

import { AcpHostRegistry } from "./host.js";
import { AcpHarnessRuntime } from "./runtime.js";
import { AcpSessionStore } from "./session-store.js";
import {
  FAKE_FLASH,
  FAKE_PRO,
  FakeLauncher,
  RecordingHost,
  fakeAgentEnv,
  fakeDefinition,
  readAgentLog,
  tempDir,
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

test("a turn without a registered host is refused instead of running an unsupervised agent", async () => {
  const h = harness();
  const result = await turn(h, [userMessage("echo:hi")]);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /only in chats you have open/u);
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

test("read-only chats refuse native mutations without asking, even when the agent writes anyway", async () => {
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
  await new Promise((resolve) => setTimeout(resolve, 400));
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
