import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import { SUBAGENT_READ_TOOL_NAMES } from "./capability-profile.js";
import type { SubagentTaskResult } from "./contracts.js";
import { SubagentEventProjector } from "./subagent-event-projector.js";
import { SubagentSupervisor, type PreparedSubagentRun } from "./subagent-supervisor.js";

function runtime(): ResolvedModelRuntime {
  return {
    provider: {
      id: "fork-provider",
      kind: "openai",
      label: "Fork provider",
      baseUrl: "https://example.invalid/v1",
      models: ["fork-model"],
      needsKey: false,
      deployment: "hosted",
    },
    model: {
      id: "fork-model",
      name: "Fork model",
      api: "openai-completions",
      provider: "fork-provider",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    },
    apiKey: undefined,
    headers: undefined,
    streams: {
      streamSimple: (() => {
        throw new Error("Unexpected provider call.");
      }) as ResolvedModelRuntime["streams"]["streamSimple"],
    },
  };
}

function task(label: string) {
  return { role: "scout" as const, label, task: `Investigate ${label}.` };
}

function completed(label: string): SubagentTaskResult {
  return { role: "scout", label, status: "completed", summary: `Result for ${label}.` };
}

function persistedChat() {
  return {
    id: "chat-fork-supervisor",
    updatedAt: 50,
    messages: [
      { id: "user", role: "user", content: "Persisted decision.", createdAt: 10 },
      {
        id: "assistant",
        role: "assistant",
        content: "Visible answer.",
        reasoning: "private",
        createdAt: 20,
      },
    ],
  };
}

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function prepared(
  complete: PreparedSubagentRun["complete"] = () => "accepted",
  abortPreparation: PreparedSubagentRun["abortPreparation"] = () => {},
): PreparedSubagentRun {
  return { complete, abortPreparation };
}

function supervisorInput() {
  return {
    generationId: "generation-fork-supervisor",
    chatId: "chat-fork-supervisor",
    workspaceId: "workspace-fork-supervisor",
    runtime: runtime(),
    thinkingLevel: "high" as const,
    workspaceRoot: "/workspace",
    permission: "full" as const,
    inheritedCeiling: SUBAGENT_READ_TOOL_NAMES,
  };
}

test("captures one revision and settles every prepare before projection or sibling launch", async () => {
  const gates = [deferred(), deferred()];
  const order: string[] = [];
  let loads = 0;
  const childContexts: Array<{ hash: string; messages: unknown[] }> = [];
  const projector = new SubagentEventProjector({
    generationId: "generation-fork-supervisor",
    chatId: "chat-fork-supervisor",
    workspaceId: "workspace-fork-supervisor",
    modelId: "fork-model",
    onSnapshot: (snapshot) => {
      if (snapshot.state === "queued") order.push(`begin:${snapshot.label}`);
    },
  });
  const supervisor = new SubagentSupervisor({
    ...supervisorInput(),
    projector,
    loadPersistedChatForFork: async () => {
      loads += 1;
      order.push("load");
      return persistedChat();
    },
    prepareRun: async ({ task: request }) => {
      const index = request.label === "One" ? 0 : 1;
      order.push(`prepare:${request.label}`);
      await gates[index]!.promise;
      order.push(`prepared:${request.label}`);
      return prepared();
    },
    runChild: async ({ request, context }) => {
      order.push(`run:${request.label}`);
      childContexts.push({ hash: context.revisionHash, messages: context.messages });
      return completed(request.label);
    },
  });

  const execution = supervisor.execute({ context: "fork", tasks: [task("One"), task("Two")] });
  await tick();
  assert.equal(loads, 1);
  assert.deepEqual(order, ["load", "prepare:One", "prepare:Two"]);

  gates[0]!.resolve();
  await tick();
  assert.deepEqual(order, ["load", "prepare:One", "prepare:Two", "prepared:One"]);

  gates[1]!.resolve();
  await execution;
  const firstBegin = order.findIndex((entry) => entry.startsWith("begin:"));
  const lastPrepared = Math.max(order.indexOf("prepared:One"), order.indexOf("prepared:Two"));
  const firstRun = order.findIndex((entry) => entry.startsWith("run:"));
  assert.ok(firstBegin > lastPrepared);
  assert.ok(firstRun > firstBegin);
  assert.equal(childContexts.length, 2);
  assert.equal(childContexts[0]?.hash, childContexts[1]?.hash);
  assert.notEqual(childContexts[0]?.messages, childContexts[1]?.messages);
  assert.notEqual(childContexts[0]?.messages[0], childContexts[1]?.messages[0]);
  assert.doesNotMatch(JSON.stringify(childContexts), /private/u);
});

test("unwinds every successful preparation when one sibling preflight fails", async () => {
  const aborted: string[] = [];
  let launches = 0;
  let projections = 0;
  const supervisor = new SubagentSupervisor({
    ...supervisorInput(),
    projector: new SubagentEventProjector({
      generationId: "generation-fork-supervisor",
      chatId: "chat-fork-supervisor",
      workspaceId: "workspace-fork-supervisor",
      modelId: "fork-model",
      onSnapshot: () => {
        projections += 1;
      },
    }),
    prepareRun: async ({ task: request }) => {
      if (request.label === "Two") throw new Error("authority rejected");
      return prepared(
        () => "accepted",
        () => {
          aborted.push(request.label);
        },
      );
    },
    runChild: async ({ request }) => {
      launches += 1;
      return completed(request.label);
    },
  });

  await assert.rejects(
    supervisor.execute({ tasks: [task("One"), task("Two")] }),
    /authority rejected/u,
  );
  assert.deepEqual(aborted, ["One"]);
  assert.equal(projections, 0);
  assert.equal(launches, 0);
  assert.equal(supervisor.launchesUsed, 0);
});

test("a partial initial persistence failure preserves admitted control ownership", async () => {
  let writes = 0;
  let launches = 0;
  const aborted: string[] = [];
  const supervisor = new SubagentSupervisor({
    ...supervisorInput(),
    projector: new SubagentEventProjector({
      generationId: "generation-fork-supervisor",
      chatId: "chat-fork-supervisor",
      workspaceId: "workspace-fork-supervisor",
      modelId: "fork-model",
      onSnapshot: () => {
        writes += 1;
        if (writes === 2) throw new Error("initial persistence failed");
      },
    }),
    prepareRun: async ({ task: request }) =>
      prepared(
        () => "accepted",
        () => {
          aborted.push(request.label);
        },
      ),
    runChild: async ({ request }) => {
      launches += 1;
      return completed(request.label);
    },
  });

  await assert.rejects(
    supervisor.execute({ tasks: [task("One"), task("Two")] }),
    /initial persistence failed/u,
  );
  assert.deepEqual(aborted, []);
  assert.equal(launches, 0);
  assert.equal(supervisor.launchesUsed, 0);
});

test("synchronous projection failure releases only runs not admitted to projection", async () => {
  for (const failureLabel of ["One", "Two"] as const) {
    const aborted: string[] = [];
    const supervisor = new SubagentSupervisor({
      ...supervisorInput(),
      projector: new SubagentEventProjector({
        generationId: "generation-fork-supervisor",
        chatId: "chat-fork-supervisor",
        workspaceId: "workspace-fork-supervisor",
        modelId: "fork-model",
        prepareSnapshot: (candidate) => {
          if (candidate.label === failureLabel) throw new Error(`reject ${failureLabel}`);
        },
      }),
      prepareRun: async ({ task: request }) =>
        prepared(
          () => "accepted",
          () => {
            aborted.push(request.label);
          },
        ),
    });

    await assert.rejects(
      supervisor.execute({ tasks: [task("One"), task("Two")] }),
      new RegExp(`reject ${failureLabel}`, "u"),
    );
    assert.deepEqual(
      aborted.sort(),
      failureLabel === "One" ? ["One", "Two"] : ["Two"],
    );
  }
});

test("expired V2 admission creates no unprepared renderer or control record", async () => {
  let now = 0;
  let preparations = 0;
  let projections = 0;
  const supervisor = new SubagentSupervisor({
    ...supervisorInput(),
    now: () => now,
    policy: { treeDeadlineMs: 10 },
    projector: new SubagentEventProjector({
      generationId: "generation-fork-supervisor",
      chatId: "chat-fork-supervisor",
      workspaceId: "workspace-fork-supervisor",
      modelId: "fork-model",
      onSnapshot: () => {
        projections += 1;
      },
    }),
    prepareRun: async () => {
      preparations += 1;
      return prepared();
    },
  });
  now = 11;

  await assert.rejects(supervisor.execute({ tasks: [task("One")] }), /before run admission/u);
  assert.equal(preparations, 0);
  assert.equal(projections, 0);
  assert.equal(supervisor.launchesUsed, 0);
});

test("one run stop is isolated and its stopped disposition fences late interrupted finish", async () => {
  const started = [deferred(), deferred()];
  const releaseSecond = deferred();
  const stops = new Map<string, (reason?: Error) => void>();
  const completions: Array<{ label: string; status: string }> = [];
  let secondAborted = false;
  const supervisor = new SubagentSupervisor({
    ...supervisorInput(),
    prepareRun: async ({ task: request, stop }) => {
      stops.set(request.label, stop);
      return prepared((result) => {
        completions.push({ label: request.label, status: result.status });
        return request.label === "One" ? "stopped" : "accepted";
      });
    },
    runChild: async ({ request, signal }) => {
      const index = request.label === "One" ? 0 : 1;
      started[index]!.resolve();
      if (request.label === "Two") {
        signal?.addEventListener("abort", () => {
          secondAborted = true;
        });
        await releaseSecond.promise;
        return completed(request.label);
      }
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason instanceof Error ? signal.reason : new Error("stopped")),
          { once: true },
        );
      });
      return completed(request.label);
    },
  });

  const execution = supervisor.execute({ tasks: [task("One"), task("Two")] });
  await Promise.all(started.map((entry) => entry.promise));
  stops.get("One")?.(new Error("user stopped one"));
  await tick();
  assert.equal(secondAborted, false);
  releaseSecond.resolve();
  const output = await execution;
  assert.match(output, /Status: interrupted/u);
  assert.match(output, /Status: completed/u);
  assert.deepEqual(completions, [
    { label: "One", status: "interrupted" },
    { label: "Two", status: "completed" },
  ]);
});

test("parent cancellation still reaches every per-run signal", async () => {
  const parent = new AbortController();
  const started = deferred();
  let aborts = 0;
  const supervisor = new SubagentSupervisor({
    ...supervisorInput(),
    prepareRun: async () => prepared(),
    runChild: async ({ signal }) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborts += 1;
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return completed("never");
    },
  });
  const reason = new Error("parent cancelled");
  const execution = supervisor.execute({ tasks: [task("One"), task("Two")] }, parent.signal);
  await started.promise;
  parent.abort(reason);
  await assert.rejects(execution, (error) => error === reason);
  assert.equal(aborts, 2);
});

test("cancellation during initial durability never tears down admitted authority", async () => {
  const parent = new AbortController();
  const writeStarted = deferred();
  const releaseWrite = deferred();
  let preparationAborts = 0;
  const completions: string[] = [];
  const projector = new SubagentEventProjector({
    generationId: "generation-fork-supervisor",
    chatId: "chat-fork-supervisor",
    workspaceId: "workspace-fork-supervisor",
    modelId: "fork-model",
    onSnapshot: async (snapshot) => {
      if (snapshot.state !== "queued") return;
      writeStarted.resolve();
      await releaseWrite.promise;
    },
  });
  const supervisor = new SubagentSupervisor({
    ...supervisorInput(),
    projector,
    prepareRun: async () =>
      prepared(
        (result) => {
          completions.push(result.status);
          return "accepted";
        },
        () => {
          preparationAborts += 1;
        },
      ),
    runChild: async ({ request }) => completed(request.label),
  });
  const reason = new Error("cancelled during durable admission");
  const execution = supervisor.execute({ tasks: [task("One")] }, parent.signal);
  await writeStarted.promise;
  parent.abort(reason);
  releaseWrite.resolve();

  await assert.rejects(execution, (error) => error === reason);
  assert.equal(preparationAborts, 0);
  assert.deepEqual(completions, ["interrupted"]);
  assert.equal(projector.snapshot()[0]?.state, "interrupted");
});
