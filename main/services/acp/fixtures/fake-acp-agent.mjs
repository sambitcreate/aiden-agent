#!/usr/bin/env node
/* global process, setTimeout, URL */
/**
 * Protocol-faithful fake ACP agent for tests. It speaks real ACP over stdio
 * through the official SDK and follows scripted prompts:
 *
 *   echo:<text>         reply with <text>
 *   think:<text>        stream a thought, then reply
 *   edit:<abs path>     ask permission (unless in yolo), write through fs/write_text_file
 *   read:<abs path>     read through fs/read_text_file and reply with its text
 *   exec                ask permission for a command; reply allowed/denied
 *   question            ask a fixed-choice question via an interaction_ permission request
 *   bridge:<tool>       call <tool> on the first HTTP MCP server and reply with its text
 *   bridge-late:<tool>  call <tool>, then call it again 400 ms later; reply with both results
 *   bridge-abandon:<tool> call <tool> but give up after 300 ms and end the turn
 *   write:<abs path>    write through fs/write_text_file without asking first
 *   read-later:<path>   end the turn, then try to read <path> 300 ms later (logged as lateRead)
 *   slow                wait until cancelled
 *   crash               exit the process mid-turn
 *   history             reply with the number of prompts this session received
 *   prompt-dump         reply with the JSON of the received prompt blocks
 *
 * Environment: FAKE_AGENT_LOG (JSON lines of calls), FAKE_AGENT_STATE (session
 * persistence across restarts), FAKE_AGENT_NOISE=1 (print a non-JSON stdout line).
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const logFile = process.env.FAKE_AGENT_LOG;
const stateFile = process.env.FAKE_AGENT_STATE;
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
const loadState = () => {
  if (!stateFile || !existsSync(stateFile)) return {};
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (state) => {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
};

if (process.env.FAKE_AGENT_NOISE === "1") process.stdout.write("Opening in existing browser session.\n");
process.stderr.write("I1006 fake agent starting\n");

const MODELS = ["fake-flash-low", "fake-flash-high", "fake-pro"];
const MODES = ["default", "auto_edit", "yolo"];
const sessions = new Map();

function configOptions(session) {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: MODELS.map((value) => ({ value, name: value })),
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: session.mode,
      options: MODES.map((value) => ({ value, name: value })),
    },
  ];
}

function newSessionState(id, cwd, mcpServers) {
  return { id, cwd, mcpServers, model: MODELS[0], mode: "default", prompts: 0, cancelled: false, wake: undefined };
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = new AgentSideConnection(
  () => ({
    async initialize(params) {
      log({ method: "initialize", fs: params.clientCapabilities?.fs, terminal: params.clientCapabilities?.terminal });
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {} },
          auth: { logout: {} },
        },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: {
          name: process.env.FAKE_AGENT_NAME ?? "fake-acp",
          title: "Fake",
          version: process.env.FAKE_AGENT_VERSION ?? "9.9.9",
        },
      };
    },
    async authenticate(params) {
      log({ method: "authenticate", methodId: params.methodId });
      if (!process.env.BROWSER || !process.env.GEMINI_HOME) return {};
      // Behave like Antigravity: listen on loopback, hand BROWSER a Google URL,
      // finish when the redirect arrives, and store a token in GEMINI_HOME.
      const state = Math.random().toString(16).slice(2);
      await new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
          const url = new URL(request.url, "http://127.0.0.1");
          response.end("ok");
          server.close();
          if (url.searchParams.get("state") !== state) reject(new Error("state mismatch"));
          else if (url.searchParams.get("error")) {
            reject(new RequestError(-32000, `Google sign-in failed: ${url.searchParams.get("error")}`));
          }
          else {
            const dir = path.join(process.env.GEMINI_HOME, "antigravity-acp");
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "acp_token.json"), JSON.stringify({ refresh_token: "1//fake" }));
            resolve();
          }
        });
        server.listen(0, "127.0.0.1", () => {
          const port = server.address().port;
          const target = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=${state}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/`)}`;
          // Like Python's webbrowser: the browser command inherits stderr.
          spawn(process.env.BROWSER, [target], { stdio: ["ignore", "ignore", "inherit"] });
        });
      });
      return {};
    },
    async newSession(params) {
      const id = `s-${Math.random().toString(16).slice(2)}`;
      const session = newSessionState(id, params.cwd, params.mcpServers);
      sessions.set(id, session);
      const state = loadState();
      state[id] = { cwd: params.cwd, prompts: 0 };
      saveState(state);
      log({ method: "newSession", sessionId: id, cwd: params.cwd, mcpServers: params.mcpServers.length });
      return { sessionId: id, configOptions: configOptions(session) };
    },
    async resumeSession(params) {
      const saved = loadState()[params.sessionId];
      log({ method: "resumeSession", sessionId: params.sessionId, known: !!saved });
      if (!saved) throw Object.assign(new Error("Unknown session"), { code: -32602 });
      const session = newSessionState(params.sessionId, params.cwd, params.mcpServers);
      session.prompts = saved.prompts;
      sessions.set(params.sessionId, session);
      return { configOptions: configOptions(session) };
    },
    async setSessionConfigOption(params) {
      const session = sessions.get(params.sessionId);
      log({ method: "setConfigOption", configId: params.configId, value: params.value });
      if (params.configId === "model") session.model = params.value;
      if (params.configId === "mode") session.mode = params.value;
      return { configOptions: configOptions(session) };
    },
    async logout() {
      log({ method: "logout" });
      return {};
    },
    async cancel(params) {
      log({ method: "cancel", sessionId: params.sessionId });
      const session = sessions.get(params.sessionId);
      if (session) {
        session.cancelled = true;
        session.wake?.();
      }
    },
    async prompt(params) {
      const session = sessions.get(params.sessionId);
      session.cancelled = false;
      session.prompts += 1;
      const state = loadState();
      state[session.id] = { cwd: session.cwd, prompts: session.prompts };
      saveState(state);
      const text = params.prompt
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .at(-1) ?? "";
      log({ method: "prompt", sessionId: session.id, model: session.model, mode: session.mode, blocks: params.prompt.map((b) => b.type), text });
      const say = (value) =>
        connection.sessionUpdate({
          sessionId: session.id,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } },
        });
      const [command, ...rest] = text.split(":");
      const argument = rest.join(":");
      switch (command) {
        case "echo":
          await say(argument);
          break;
        case "think":
          await connection.sessionUpdate({
            sessionId: session.id,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } },
          });
          await say(argument);
          break;
        case "edit": {
          const toolCallId = "edit-1";
          await connection.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: `Edit ${argument}`,
              kind: "edit",
              status: "pending",
              locations: [{ path: argument }],
            },
          });
          if (session.mode !== "yolo") {
            const decision = await connection.requestPermission({
              sessionId: session.id,
              toolCall: { toolCallId, title: `Edit ${argument}`, kind: "edit", locations: [{ path: argument }] },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "always", name: "Allow for this chat", kind: "allow_always", _meta: { "agy.security.warning": { title: "Careful", message: "Prompt injection risk" } } },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            });
            log({ method: "permissionResult", outcome: decision.outcome });
            if (decision.outcome.outcome !== "selected" || decision.outcome.optionId === "deny") {
              await connection.sessionUpdate({
                sessionId: session.id,
                update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
              });
              await say("edit denied");
              break;
            }
          }
          let written = "write failed";
          try {
            await connection.writeTextFile({ sessionId: session.id, path: argument, content: "new line\n" });
            written = "edit applied";
          } catch (error) {
            written = `write refused: ${error.message}`;
          }
          await connection.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: written === "edit applied" ? "completed" : "failed",
              content: [{ type: "diff", path: argument, oldText: "old line\n", newText: "new line\n" }],
            },
          });
          await say(written);
          break;
        }
        case "read": {
          try {
            const result = await connection.readTextFile({ sessionId: session.id, path: argument });
            await say(`read:${result.content}`);
          } catch (error) {
            await say(`read refused: ${error.message}`);
          }
          break;
        }
        case "exec": {
          const toolCallId = "exec-1";
          await connection.sessionUpdate({
            sessionId: session.id,
            update: { sessionUpdate: "tool_call", toolCallId, title: "rm -rf build", kind: "execute", status: "pending" },
          });
          const decision = session.mode === "yolo"
            ? { outcome: { outcome: "selected", optionId: "allow" } }
            : await connection.requestPermission({
                sessionId: session.id,
                toolCall: { toolCallId, title: "rm -rf build", kind: "execute" },
                options: [
                  { optionId: "allow", name: "Allow once", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              });
          const allowed = decision.outcome.outcome === "selected" && decision.outcome.optionId === "allow";
          await connection.sessionUpdate({
            sessionId: session.id,
            update: { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" },
          });
          await say(allowed ? "command ran" : "command denied");
          break;
        }
        case "question": {
          const decision = await connection.requestPermission({
            sessionId: session.id,
            toolCall: { toolCallId: "interaction_42", title: "Which color?", kind: "other" },
            options: [
              { optionId: "red", name: "Red", kind: "allow_once" },
              { optionId: "blue", name: "Blue", kind: "allow_once" },
            ],
          });
          await say(`answer:${decision.outcome.outcome === "selected" ? decision.outcome.optionId : "none"}`);
          break;
        }
        case "bridge": {
          const server = session.mcpServers.find((candidate) => candidate.type === "http");
          if (!server) {
            await say("no bridge");
            break;
          }
          const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
          const client = new Client({ name: "fake-agent", version: "1.0.0" });
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
          const tools = await client.listTools();
          log({ method: "bridgeTools", names: tools.tools.map((tool) => tool.name) });
          await connection.sessionUpdate({
            sessionId: session.id,
            update: { sessionUpdate: "tool_call", toolCallId: "mcp-1", title: `aiden/${argument}`, kind: "other", status: "in_progress", _meta: { is_mcp_tool_call: true } },
          });
          const result = await client.callTool({ name: argument, arguments: { value: "hello" } });
          await client.close();
          const resultText = result.content.map((item) => item.text ?? "").join("");
          await say(`bridge:${resultText}`);
          break;
        }
        case "bridge-late":
        case "bridge-abandon": {
          const server = session.mcpServers.find((candidate) => candidate.type === "http");
          const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
          const client = new Client({ name: "fake-agent", version: "1.0.0" });
          await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
          const call = (value) =>
            client
              .callTool({ name: argument, arguments: { value } }, undefined, command === "bridge-abandon" ? { timeout: 300 } : undefined)
              .then((result) => result.content.map((item) => item.text ?? "").join(""))
              .catch(() => "gave-up");
          const results = command === "bridge-late"
            ? await Promise.all([call("first"), new Promise((resolve) => setTimeout(resolve, 400)).then(() => call("second"))])
            : [await call("only")];
          await client.close().catch(() => {});
          await say(`${command}:${results.join(",")}`);
          break;
        }
        case "read-later": {
          setTimeout(() => {
            connection
              .readTextFile({ sessionId: session.id, path: argument })
              .then(() => log({ method: "lateRead", ok: true }))
              .catch(() => log({ method: "lateRead", ok: false }));
          }, 300);
          await say("scheduled");
          break;
        }
        case "write": {
          try {
            await connection.writeTextFile({ sessionId: session.id, path: argument, content: "unasked\n" });
            await say("wrote");
          } catch (error) {
            await say(`write refused: ${error.message}`);
          }
          break;
        }
        case "slow":
          await say("working");
          await new Promise((resolve) => {
            session.wake = resolve;
            if (session.cancelled) resolve();
          });
          // Real agents often stream a little more before honouring cancel.
          await say(" late chunk after cancel");
          return { stopReason: "cancelled" };
        case "crash":
          await say("about to crash");
          setTimeout(() => process.exit(3), 20);
          await new Promise(() => {});
          break;
        case "history":
          await say(`prompts:${session.prompts}`);
          break;
        case "prompt-dump":
          await say(JSON.stringify(params.prompt));
          break;
        default:
          await say(`unknown:${text}`);
      }
      if (session.cancelled) return { stopReason: "cancelled" };
      return { stopReason: "end_turn", usage: { totalTokens: 15, inputTokens: 10, outputTokens: 5 } };
    },
  }),
  stream,
);
void connection;
