import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as acpHarness from "../../renderer/shared/acp-harness.js";
import * as geminiUsageScope from "../../renderer/shared/gemini-usage-scope.js";
import * as modelVisibility from "../../renderer/shared/model-visibility.js";
import { APPROVAL_TOOL_NAMES } from "./coding-tools.js";
import * as conversationSurfaceGeneration from "./conversation-surface-generation.js";
import * as scheduleGuard from "./schedule-guard.js";
import * as scheduleNotification from "./schedule-notification.js";
import { SCHEDULE_TOOL_NAME } from "./schedule-tool.js";
import * as scheduledChatCreation from "./scheduled-chat-creation.js";
import * as scheduledGenerationPolicy from "./scheduled-generation-policy.js";
import type { ScheduledTask } from "./types.js";

// Runs the real scheduled LLM execution path and records what it hands the
// generation client. Policy, surface and guard modules are the production
// ones; only Electron, storage, provider and network services are synthetic.

const FINGERPRINT = "a".repeat(64);

interface StartedGeneration {
  params: { mode?: string; providerId: string; model: string };
  options: {
    permission: string;
    excludeToolNames: ReadonlySet<string>;
    allowComputerUse: boolean;
    allowSubagents: boolean;
    allowMcpTools: boolean;
    mcpServerIds?: readonly string[];
    providerFingerprint?: string;
  };
}

function task(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Morning brief",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    notify: false,
    prompt: "Summarize my inbox.",
    providerId: "provider-1",
    model: "model-1",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

async function executionHarness(webSearch: () => Promise<{ ready?: boolean }>) {
  const started: StartedGeneration[] = [];
  let availabilityReads = 0;
  const chat = { id: "chat-1", title: "Morning brief", updatedAt: 1 };
  const ports: Record<string, unknown> = {
    "node:path": path,
    "node:crypto": crypto,
    "../platform.js": {
      Notification: class {
        static isSupported() {
          return false;
        }
      },
      ipcMain: { broadcast: () => undefined },
      logger: { warn: () => undefined },
    },
    "./chat-store.js": { chatStore: { get: async () => chat, appendMessage: async () => chat } },
    "./config-store.js": {
      configStore: {
        getSettings: async () => ({}),
        getWorkspace: async () => null,
        getProvider: async () => null,
      },
    },
    "./provider-registry.js": {
      providerRegistry: {
        selectionProvider: async (id: string) => ({ id, label: "Provider", models: ["model-1"] }),
      },
    },
    "./web-search-main.js": {
      webSearchService: {
        availability: () => {
          availabilityReads += 1;
          return webSearch();
        },
      },
    },
    "./llm-client.js": {
      llmClient: {
        beginChatTurn: () => ({ release() {}, settleAsyncWork() {} }),
        start: async (
          _streamId: string,
          params: StartedGeneration["params"],
          owner: { send(channel: string, payload: unknown): void },
          options: StartedGeneration["options"],
        ) => {
          started.push({ params, options });
          owner.send("chat:done", { content: "Done." });
          return true;
        },
        waitForChatIdle: async () => true,
        cancel: () => false,
      },
    },
    "./scheduled-generation-policy.js": scheduledGenerationPolicy,
    "./conversation-surface-generation.js": conversationSurfaceGeneration,
    "./schedule-guard.js": scheduleGuard,
    "./schedule-notification.js": scheduleNotification,
    "./scheduled-chat-creation.js": scheduledChatCreation,
    "../../renderer/shared/model-visibility.js": modelVisibility,
    "../../renderer/shared/gemini-usage-scope.js": geminiUsageScope,
    "../../renderer/shared/acp-harness.js": acpHarness,
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./schedule-execution.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "synthetic-execution-ports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            args.importer.endsWith("/schedule-execution.ts") ? { path: args.path, external: true } : undefined,
          );
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(
    (id: string) => ports[id] ?? {},
    module,
    module.exports,
  );
  const { createScheduleExecution } = module.exports as typeof import("./schedule-execution.js");
  const store = {
    ensureChatId: async () => chat.id,
    recordRun: async (run: object) => ({ ...run, id: "run-1" }),
  };
  const execution = createScheduleExecution(store as unknown as Parameters<typeof createScheduleExecution>[0]);
  return {
    async run(scheduled: ScheduledTask) {
      const run = await execution.run(scheduled);
      assert.equal(run.result, "success", run.error);
      assert.equal(started.length, 1, "exactly one generation starts");
      return started[0]!;
    },
    availabilityReads: () => availabilityReads,
  };
}

const notReady = async () => ({ ready: false });

test("a scheduled run never re-offers scheduling, Computer Use or subagents", async () => {
  const h = await executionHarness(notReady);
  const { options } = await h.run(task({ permission: "full", mcpServerIds: [] }));
  assert.ok(options.excludeToolNames.has(SCHEDULE_TOOL_NAME));
  assert.ok(options.excludeToolNames.has("web_search"), "web search was not granted");
  assert.equal(options.allowComputerUse, false);
  assert.equal(options.allowSubagents, false);
  assert.equal(options.allowMcpTools, false);
  assert.equal(h.availabilityReads(), 0, "availability is never read without a grant");
});

test("a read-only scheduled run withholds every approval-gated tool", async () => {
  const h = await executionHarness(notReady);
  const { options } = await h.run(task({ permission: "read-only", mcpServerIds: ["server-a"] }));
  for (const name of APPROVAL_TOOL_NAMES) assert.ok(options.excludeToolNames.has(name), name);
  assert.equal(options.allowMcpTools, false, "connectors require Full permission");
});

test("a scheduled run reaches exactly its approved MCP servers", async () => {
  const h = await executionHarness(notReady);
  const { options } = await h.run(task({ permission: "full", mcpServerIds: ["server-a"] }));
  assert.equal(options.allowMcpTools, true);
  assert.deepEqual(options.mcpServerIds, ["server-a"]);
  for (const name of APPROVAL_TOOL_NAMES) assert.ok(!options.excludeToolNames.has(name), name);
});

test("a granted web search is offered only while the service is ready", async () => {
  const ready = await executionHarness(async () => ({ ready: true }));
  const granted = await ready.run(task({ webSearchEnabled: true }));
  assert.ok(!granted.options.excludeToolNames.has("web_search"));

  const failing = await executionHarness(async () => {
    throw new Error("settings unreadable");
  });
  const failedClosed = await failing.run(task({ webSearchEnabled: true }));
  assert.ok(failedClosed.options.excludeToolNames.has("web_search"));
});

test("an unattended Assistant run carries its approved provider fingerprint into generation", async () => {
  const h = await executionHarness(notReady);
  const { params, options } = await h.run(
    task({
      executionProfile: "assistant",
      permission: "read-only",
      mcpServerIds: [],
      providerFingerprint: FINGERPRINT,
    }),
  );
  assert.equal(params.mode, "assistant-unattended");
  assert.equal(options.providerFingerprint, FINGERPRINT);
});
