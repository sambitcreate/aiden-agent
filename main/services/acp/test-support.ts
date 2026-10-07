/**
 * Shared fixtures for ACP harness tests: a launcher that runs the fake agent
 * through the real process and connection stack, a generic test harness
 * definition, and a recording host.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  normalizeContext,
  type Api,
  type Message,
  type Model,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildChildEnvironment } from "./environment.js";
import type { AcpHarnessDefinition, AcpHostPermission, AcpQuestion } from "./harness.js";
import type { AcpApprovalOutcome, AcpApprovalRequest, AcpTurnHost } from "./host.js";
import { AcpProcess } from "./process.js";
import type { AcpLaunchedProcess, AcpProcessLauncher } from "./runtime.js";

export const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

export function tempDir(prefix = "aiden-acp-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export interface FakeAgentEnv {
  log: string;
  state: string;
  extra?: Record<string, string>;
}

export function fakeAgentEnv(dir: string = tempDir()): FakeAgentEnv {
  return { log: path.join(dir, "agent.log"), state: path.join(dir, "agent-state.json") };
}

export function readAgentLog(env: FakeAgentEnv): Array<Record<string, unknown>> {
  if (!existsSync(env.log)) return [];
  return readFileSync(env.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait until the fake agent has logged a matching call (no fixed sleeps). */
export async function waitForAgentLog(
  env: FakeAgentEnv,
  predicate: (entry: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!readAgentLog(env).some(predicate)) {
    if (Date.now() > deadline) throw new Error("The fake agent never logged the expected call.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export class FakeLauncher implements AcpProcessLauncher {
  launches: Array<{ purpose: string; cwd: string }> = [];
  processes: AcpProcess[] = [];

  constructor(private readonly env: FakeAgentEnv) {}

  async launch(purpose: string, cwd: string): Promise<AcpLaunchedProcess> {
    this.launches.push({ purpose, cwd });
    const process = new AcpProcess({
      command: globalThis.process.execPath,
      args: [FAKE_AGENT],
      cwd,
      env: buildChildEnvironment({
        set: {
          FAKE_AGENT_LOG: this.env.log,
          FAKE_AGENT_STATE: this.env.state,
          ...(this.env.extra ?? {}),
        },
      }),
    });
    this.processes.push(process);
    return { process, dispose: () => process.close() };
  }
}

function model(id: string, name: string, reasoning: boolean): Model<Api> {
  return {
    id,
    name,
    api: "fake-acp" as Api,
    provider: "fake",
    baseUrl: "",
    reasoning,
    ...(reasoning ? { thinkingLevelMap: { low: `${id}-low`, high: `${id}-high` } } : {}),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
}

export const FAKE_FLASH = model("fake-flash", "Fake Flash", true);
export const FAKE_PRO = model("fake-pro", "Fake Pro", false);

export const fakeDefinition: AcpHarnessDefinition = {
  id: "fake",
  label: "Fake Agent",
  api: "fake-acp" as Api,
  agentName: "fake-acp",
  release: { version: "9.9.9", platforms: {} },
  fileSystem: true,
  validateInitialize(initialize, version) {
    if (initialize.agentInfo?.name !== "fake-acp") return "Wrong agent.";
    if (initialize.agentInfo.version !== version) return "Wrong version.";
    return undefined;
  },
  async prepareLaunch() {
    throw new Error("not used");
  },
  nativeModeFor(permission: AcpHostPermission) {
    return permission === "full" ? "yolo" : "default";
  },
  fallbackModels: () => [FAKE_FLASH, FAKE_PRO],
  projectModels(options: readonly SessionConfigOption[]) {
    const option = options.find((candidate) => candidate.category === "model");
    return { models: option ? [FAKE_FLASH, FAKE_PRO] : [], modelConfigId: option?.id };
  },
  nativeModelId(target, reasoning) {
    if (!target.reasoning) return target.id;
    return reasoning === "high" || reasoning === "xhigh" ? `${target.id}-high` : `${target.id}-low`;
  },
  classifyPermission(request) {
    if (String(request.toolCall.toolCallId).startsWith("interaction_")) {
      return {
        kind: "question",
        question: {
          title: request.toolCall.title ?? "Question",
          options: request.options.map((option) => ({ id: option.optionId, label: option.name })),
        },
      };
    }
    const warning = request.options.find((option) => option.kind === "allow_always")?._meta?.[
      "agy.security.warning"
    ] as { message?: string } | undefined;
    return { kind: "approval", ...(warning?.message ? { warning: warning.message } : {}) };
  },
};

export interface RecordedActivity {
  event: "started" | "running" | "finished";
  id: string;
  toolName?: string;
  args?: Record<string, unknown>;
  status?: string;
  details?: unknown;
}

export class RecordingHost implements AcpTurnHost {
  readonly activities: RecordedActivity[] = [];
  readonly approvals: AcpApprovalRequest[] = [];
  readonly questions: AcpQuestion[] = [];
  readonly notices: string[] = [];
  readonly writes: string[] = [];
  approvalAnswer: AcpApprovalOutcome = "allow_once";
  questionAnswer: string | undefined = "blue";
  currentPermission: AcpHostPermission = "ask";
  tools: Tool[] = [];

  constructor(
    readonly chatId: string,
    readonly cwd: string,
    readonly roots: readonly string[] = [cwd],
  ) {}

  permission(): AcpHostPermission {
    return this.currentPermission;
  }

  async requestApproval(request: AcpApprovalRequest): Promise<AcpApprovalOutcome> {
    this.approvals.push(request);
    return this.approvalAnswer;
  }

  async askQuestion(question: AcpQuestion): Promise<string | undefined> {
    this.questions.push(question);
    return this.questionAnswer;
  }

  activity = {
    started: (id: string, toolName: string, args: Record<string, unknown>) =>
      this.activities.push({ event: "started", id, toolName, args }),
    running: (id: string) => this.activities.push({ event: "running", id }),
    finished: (id: string, status: string, details?: unknown) =>
      this.activities.push({ event: "finished", id, status, details }),
  };

  bridgeableTools(tools: readonly Tool[]): Tool[] {
    return [...tools];
  }

  notice(text: string): void {
    this.notices.push(text);
  }

  onFileWrite(absolutePath: string): void {
    this.writes.push(absolutePath);
  }
}

export function userMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

export function transcript(messages: Message[], systemPrompt = "Be helpful.", tools: Tool[] = []): TranscriptContext {
  return normalizeContext({ systemPrompt, messages, tools });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A minimal stored (uncompressed) ZIP archive for installer tests. */
export function storedZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
