import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { showScheduledNotification } from "./schedule-notification.js";
import type { ScheduledRun, ScheduledTask } from "./types.js";

function task(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Daily brief",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    notify: true,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

test("notification truncates output and opens the dedicated chat on click", async () => {
  let click: (() => void) | undefined;
  let options: { title: string; body: string } | undefined;
  const opened: string[] = [];
  const shown = showScheduledNotification(task(), `  ${"result ".repeat(30)}  `, "chat-1", {
    isSupported: () => true,
    create: (input) => {
      options = input;
      return {
        on: (_event, listener) => {
          click = listener;
        },
        show: () => undefined,
      };
    },
    openChat: async (chatId) => {
      opened.push(chatId);
    },
  });
  assert.equal(shown, true);
  assert.equal(options?.title, "Daily brief");
  assert.equal(options?.body.length, 120);
  click?.();
  await Promise.resolve();
  assert.deepEqual(opened, ["chat-1"]);
});

test("notification honors task opt-out and platform support", () => {
  let creates = 0;
  const dependencies = {
    isSupported: () => true,
    create: () => {
      creates += 1;
      return { on: () => undefined, show: () => undefined };
    },
    openChat: () => undefined,
  };
  assert.equal(
    showScheduledNotification(task({ notify: false }), "done", "chat-1", dependencies),
    false,
  );
  assert.equal(
    showScheduledNotification(task(), "done", "chat-1", {
      ...dependencies,
      isSupported: () => false,
    }),
    false,
  );
  assert.equal(creates, 0);
});

for (const stage of ["support", "create", "subscribe", "show"] as const) {
  test(`notification ${stage} failure cannot interrupt recorded run completion`, () => {
    const failure = new Error(`synthetic ${stage} failure`);
    const errors: unknown[] = [];
    const calls: string[] = [];
    const failAt = (step: typeof stage) => {
      calls.push(step);
      if (step === stage) throw failure;
    };
    const dependencies = {
      isSupported: () => {
        failAt("support");
        return true;
      },
      create: () => {
        failAt("create");
        return {
          on: () => failAt("subscribe"),
          show: () => failAt("show"),
        };
      },
      openChat: () => assert.fail("must not navigate without a click"),
      onError: (_stage: string, error: unknown) => errors.push(error),
    };
    assert.equal(showScheduledNotification(task(), "saved result", "chat-1", dependencies), false);
    assert.deepEqual(errors, [failure]);
    assert.equal(calls[calls.length - 1], stage);
  });
}

for (const kind of ["throw", "reject"] as const) {
  test(`notification click contains navigation ${kind}`, async () => {
    const failure = new Error(`synthetic navigation ${kind}`);
    const errors: unknown[] = [];
    let click: (() => void) | undefined;
    const dependencies = {
      isSupported: () => true,
      create: () => ({
        on: (_event: "click", listener: () => void) => {
          click = listener;
        },
        show: () => undefined,
      }),
      openChat: () => {
        if (kind === "throw") throw failure;
        return Promise.reject(failure);
      },
      onError: (_stage: string, error: unknown) => errors.push(error),
    };
    assert.equal(showScheduledNotification(task(), "done", "chat-1", dependencies), true);
    assert.doesNotThrow(() => click?.());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, [failure]);
  });
}

test("notification diagnostics cannot turn delivery failure into a task failure", () => {
  const dependencies = {
    isSupported: () => true,
    create: () => {
      throw new Error("synthetic delivery failure");
    },
    openChat: () => undefined,
    onError: () => {
      throw new Error("synthetic logger failure");
    },
  };
  assert.equal(showScheduledNotification(task(), "done", "chat-1", dependencies), false);
});

test("opt-out does not probe platform support and missing chat does not register a click", () => {
  let probes = 0;
  let subscriptions = 0;
  let shown = 0;
  const dependencies = {
    isSupported: () => {
      probes += 1;
      return true;
    },
    create: () => ({
      on: () => {
        subscriptions += 1;
      },
      show: () => {
        shown += 1;
      },
    }),
    openChat: () => assert.fail("no target chat"),
  };
  assert.equal(
    showScheduledNotification(task({ notify: false }), "done", undefined, dependencies),
    false,
  );
  assert.equal(probes, 0);
  assert.equal(showScheduledNotification(task(), "done", undefined, dependencies), true);
  assert.equal(probes, 1);
  assert.equal(subscriptions, 0);
  assert.equal(shown, 1);
});

// Bundle the real execution module and notification helper, replacing only its
// external service ports. No Electron process, script, provider or user data is used.
async function executionHarness(
  options: {
    notificationFailure?: "create" | "show";
    scriptFailure?: boolean;
    output?: string;
  } = {},
) {
  const records: ScheduledRun[] = [];
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const warnings: unknown[][] = [];
  const chat = { id: "chat-1", title: "Daily brief", updatedAt: 1 };
  const output = options.output ?? "completed output";
  const notificationFailure = new Error("synthetic notification failure: PRIVATE_DETAIL");
  const ports: Record<string, unknown> = {
    "node:path": path,
    "../platform.js": {
      Notification: class {
        static isSupported() {
          return true;
        }
        constructor() {
          if (options.notificationFailure === "create") throw notificationFailure;
        }
        on() {
          return this;
        }
        show() {
          if (options.notificationFailure === "show") throw notificationFailure;
        }
      },
      ipcMain: {
        broadcast: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
      },
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    },
    "./chat-store.js": {
      chatStore: {
        get: async () => chat,
        appendMessage: async () => chat,
      },
    },
    "./llm-client.js": {
      llmClient: {
        beginChatTurn: () => ({ release() {}, settleAsyncWork() {} }),
      },
    },
    "./schedule-guard.js": { assertAssistantScheduleExecutionBoundary() {} },
    "./schedule-script.js": {
      resolveScheduledScript: async () => "/synthetic/script.sh",
      runScheduledScript: async () => {
        if (options.scriptFailure) throw new Error("synthetic script failure");
        return { stdout: output, stderr: "", exitCode: 0 };
      },
    },
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
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (
              args.importer.endsWith("/schedule-execution.ts") &&
              args.path !== "./schedule-notification.js"
            ) {
              return { path: args.path, external: true };
            }
            return undefined;
          });
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
    recordRun: async (run: Omit<ScheduledRun, "id"> & { id?: string }) => {
      const recorded = { ...run, id: run.id ?? "run-1" };
      records.push(recorded);
      return recorded;
    },
  };
  const execution = createScheduleExecution(
    store as unknown as Parameters<typeof createScheduleExecution>[0],
  );
  return { execution, records, broadcasts, warnings };
}

for (const failure of ["create", "show"] as const) {
  test(`real execution preserves completed run and broadcast after notification ${failure} failure`, async () => {
    const h = await executionHarness({ notificationFailure: failure });
    const run = await h.execution.run(
      task({ mode: "script", permission: "full", script: "/synthetic/script.sh" }),
    );
    assert.equal(run.result, "success");
    assert.equal(run.output, "completed output");
    assert.equal(h.records.length, 1);
    assert.deepEqual(
      h.broadcasts.filter(({ channel }) => channel === "schedule:updated"),
      [{ channel: "schedule:updated", payload: { taskId: "task-1", run } }],
    );
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(h.warnings, [["schedule", "Scheduled notification delivery failed."]]);
    // A second run is admitted: the first run released its active controller.
    await h.execution.run(task({ mode: "script", permission: "full", notify: false }));
    assert.equal(h.records.length, 2);
    assert.equal(h.warnings.length, 1);
  });
}

test("real execution preserves task errors and silent results independently of delivery", async () => {
  const failed = await executionHarness({ scriptFailure: true, notificationFailure: "show" });
  const run = await failed.execution.run(task({ mode: "script", permission: "full" }));
  assert.equal(run.result, "error");
  assert.equal(run.error, "synthetic script failure");
  assert.equal(failed.records.length, 1);
  assert.equal(failed.warnings.length, 1);
  const silent = await executionHarness({ output: "", notificationFailure: "create" });
  const silentRun = await silent.execution.run(task({ mode: "script", permission: "full" }));
  assert.equal(silentRun.result, "silent");
  assert.equal(silent.records.length, 1);
  assert.equal(silent.warnings.length, 0);
  assert.equal(silent.broadcasts.filter(({ channel }) => channel === "schedule:updated").length, 1);
});
