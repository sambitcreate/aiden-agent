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
