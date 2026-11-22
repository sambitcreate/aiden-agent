import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as path from "node:path";
import test from "node:test";
import { analyticsSettled, captureAnalyticsEvents } from "./analytics/test-support.js";
import * as analyticsFeatureReports from "./analytics/analytics-feature-reports.js";
import * as analyticsIds from "./analytics/analytics-ids.js";
import * as analyticsReport from "./analytics/analytics-report.js";
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
import * as scheduleChatDelivery from "./schedule-chat-delivery.js";
import * as scheduledTaskPresentation from "../../renderer/shared/scheduled-task-presentation.js";
import type { ScheduledTask } from "./types.js";

// Runs the real scheduled LLM execution path and records what it hands the
// generation client. Policy, surface and guard modules are the production
// ones; only Electron, storage, provider and network services are synthetic.

const FINGERPRINT = "a".repeat(64);

interface StartedGeneration {
  params: { mode?: string; providerId: string; model: string; chatId?: string };
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

async function executionHarness(
  webSearch: () => Promise<{ ready?: boolean }>,
  finish: [channel: string, payload: unknown] = ["chat:done", { content: "Done." }],
  extra: {
    chats?: Record<string, { id: string; providerId?: string; model?: string; [key: string]: unknown }>;
    workspace?: { id: string };
    /** Runs while the generation is going, after it switched the chat to the task's model. */
    duringRun?: (chat: { providerId?: string; model?: string }) => void;
  } = {},
) {
  const started: StartedGeneration[] = [];
  const appended: Array<{
    chatId: string;
    message: { role: string; content: string; notice?: { source: string } };
    meta?: { providerId?: string; model?: string };
  }> = [];
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
    "./chat-store.js": {
      chatStore: {
        get: async (id: string) => extra.chats?.[id] ?? chat,
        appendMessage: async (
          chatId: string,
          message: (typeof appended)[number]["message"],
          meta?: (typeof appended)[number]["meta"],
        ) => {
          appended.push({ chatId, message, meta });
          // Like the real store, an append's model becomes the chat's model.
          const target = extra.chats?.[chatId];
          if (target && meta?.providerId) target.providerId = meta.providerId;
          if (target && meta?.model) target.model = meta.model;
          return chat;
        },
        setChatModelSelection: async (
          chatId: string,
          providerId: string,
          model: string,
          assertCurrent: (current: { providerId?: string; model?: string }) => void,
        ) => {
          const target = extra.chats?.[chatId];
          if (!target) throw new Error("Chat not found");
          assertCurrent(target);
          target.providerId = providerId;
          target.model = model;
          return target;
        },
      },
    },
    "./workspace-folder-presence.js": { assertWorkspaceFolderPresent: async () => undefined },
    "./managed-worktree-admission.js": { assertManagedWorktreeAdmission: async () => undefined },
    "./follow-through/notice-delivery-main.js": {
      noticeDelivery: {
        post: async () => ({ kind: "recorded", messageId: "notice-1", reason: "not-waking" }),
        inOrder: (_chatId: string, work: () => Promise<unknown>) => work(),
      },
    },
    "./config-store.js": {
      configStore: {
        getSettings: async () => ({}),
        getWorkspace: async (id: string) =>
          extra.workspace?.id === id
            ? { ...extra.workspace, name: "Workspace", permission: "full", folderPath: "/workspace", createdAt: 1, updatedAt: 1 }
            : null,
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
        beginChatTurn: () => ({ release() {}, settleAsyncWork() {}, reserveAppendPayload() {}, isActive: () => true }),
        start: async (
          _streamId: string,
          params: StartedGeneration["params"],
          owner: { send(channel: string, payload: unknown): void },
          options: StartedGeneration["options"],
        ) => {
          started.push({ params, options });
          // The real generation saves its answer with its model, which the
          // store copies onto the chat.
          const target = params.chatId ? extra.chats?.[params.chatId] : undefined;
          if (target) {
            target.providerId = params.providerId;
            target.model = params.model;
            extra.duringRun?.(target);
          }
          owner.send(...finish);
          return true;
        },
        waitForChatIdle: async () => true,
        waitForChatIdleWithin: async () => true,
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
    "./schedule-chat-delivery.js": scheduleChatDelivery,
    "../../renderer/shared/scheduled-task-presentation.js": scheduledTaskPresentation,
  };
  ports["./analytics/analytics-report.js"] = analyticsReport;
  ports["./analytics/analytics-ids.js"] = analyticsIds;
  ports["./analytics/analytics-feature-reports.js"] = analyticsFeatureReports;
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
    runToEnd: (scheduled: ScheduledTask) => execution.run(scheduled),
    appended,
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

test("a run stopped by a permission counts as failed", async (t) => {
  const sent = captureAnalyticsEvents(t);
  const h = await executionHarness(notReady, ["chat:error", { message: "Blocked: this tool is read-only." }]);
  const run = await h.runToEnd(task());
  assert.equal(run.result, "blocked");
  assert.deepEqual(
    sent.filter(({ event }) => event === "scheduled_task_ran").map(({ props }) => props?.result),
    ["failed"],
  );
});

test("a scheduled run counts its one generated message as coming from the schedule", async (t) => {
  const sent = captureAnalyticsEvents(t);
  const h = await executionHarness(notReady);
  await h.run(task({ permission: "full", mcpServerIds: [] }));
  await analyticsSettled();
  assert.deepEqual(
    sent.filter(({ event }) => event === "chat_message_sent").map(({ props }) => props?.origin),
    ["schedule"],
  );
});

test("a task made in a chat runs there under the task's own policy, its prompt saved as a notice", async () => {
  // A chat-bound task always has a project, and a project task has no MCP
  // servers, so the policy that matters is the task's permission.
  const h = await executionHarness(notReady, undefined, {
    chats: { "chat-origin": { id: "chat-origin", title: "Planning", workspaceId: "workspace-1", updatedAt: 1 } },
    workspace: { id: "workspace-1" },
  });
  const { params, options } = await h.run(task({
    permission: "read-only", mcpServerIds: [], workspaceId: "workspace-1", originChatId: "chat-origin",
  }));
  assert.equal(params.chatId, "chat-origin", "the answer is generated in the chat the task was made in");
  for (const name of APPROVAL_TOOL_NAMES) assert.ok(options.excludeToolNames.has(name), name);
  assert.equal(options.allowMcpTools, false);
  assert.ok(options.excludeToolNames.has(SCHEDULE_TOOL_NAME), "a bound run still can't schedule more work");
  const prompt = h.appended.find((entry) => entry.message.role === "user");
  assert.equal(prompt?.chatId, "chat-origin");
  assert.equal(prompt?.message.notice?.source, "schedule");
  assert.match(prompt?.message.content ?? "", /Summarize my inbox\./u);
});

test("a task answering in a chat with another model leaves the chat on its own model", async () => {
  const origin = { id: "chat-origin", title: "Planning", workspaceId: "workspace-1", updatedAt: 1, providerId: "chat-provider", model: "chat-model" };
  const h = await executionHarness(notReady, undefined, { chats: { "chat-origin": origin }, workspace: { id: "workspace-1" } });
  const { params } = await h.run(task({ workspaceId: "workspace-1", originChatId: "chat-origin" }));
  assert.equal(params.model, "model-1", "the task answers with its own model");
  const notice = h.appended.find((entry) => entry.message.notice?.source === "schedule");
  assert.equal(notice?.meta?.providerId, undefined, "the notice doesn't switch the chat's model");
  assert.equal(notice?.meta?.model, undefined);
  assert.deepEqual([origin.providerId, origin.model], ["chat-provider", "chat-model"]);

  const picked = { ...origin, id: "chat-picked" };
  const during = await executionHarness(notReady, undefined, {
    chats: { "chat-picked": picked },
    workspace: { id: "workspace-1" },
    duringRun: (chat) => {
      chat.providerId = "picked-provider";
      chat.model = "picked-model";
    },
  });
  await during.run(task({ workspaceId: "workspace-1", originChatId: "chat-picked" }));
  assert.deepEqual([picked.providerId, picked.model], ["picked-provider", "picked-model"], "a model the person picked mid-run wins");
});
