/* global fetch */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_SAVED_TEXT,
  ACCEPTANCE_TEXT,
  acceptanceCapabilityBaseUrl,
  acceptanceChatCompletionPath,
  acceptanceFixture,
  acceptanceToolCall,
  evaluateAcceptanceRequests,
  openAiToolCallChunks,
  resolveAcceptanceTarget,
} from "./computer-use-packaged-acceptance-core.mjs";
import {
  bindOwnedProcesses,
  computerUseHelperExecutables,
  emergencyCleanup,
  launchTrackedApplicationProcess,
  resolveTextEditExecutable,
  startAcceptanceModel,
  terminateLingeringComputerUseProcesses,
  waitForCleanComputerUseExit,
  waitForStopTeardown,
} from "./computer-use-packaged-acceptance.mjs";

const target = {
  pid: 123,
  window_id: 456,
  app_name: "TextEdit",
  title: "Aiden CUA Acceptance 123.txt",
};

test("Gemini Live reuses the packaged Computer Use controller without a privileged bridge", async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const source = await readFile(
    path.join(root, "main/services/gemini-live/service-main.ts"),
    "utf8",
  );
  assert.match(source, /createComputerUseController\(`live:\$\{sessionId\}`/u);
  assert.match(source, /computerUseStatus\.status\(\{ signal \}\)/u);
  assert.doesNotMatch(source, /fake-cua-driver|acceptance.*shortcut|skip.*approval/iu);
});

function assistantMessage(callIndex, args) {
  return {
    role: "assistant",
    tool_calls: [
      {
        id: `aiden-cua-call-${callIndex}`,
        type: "function",
        function: { name: "computer_use", arguments: JSON.stringify(args) },
      },
    ],
  };
}

function toolMessage(callIndex, content) {
  return {
    role: "tool",
    tool_call_id: `aiden-cua-call-${callIndex}`,
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
}

function imageMessage() {
  return {
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
  };
}

function successfulRequests() {
  const resultTarget = {
    pid: target.pid,
    windowId: target.window_id,
    app: target.app_name,
    title: target.title,
  };
  const windows = {
    ok: true,
    action: "list_windows",
    windows: [target],
  };
  const capture = (mode) => ({
    ok: true,
    action: "capture",
    mode,
    target: resultTarget,
    elements: mode === "som" ? [{ value: ACCEPTANCE_SAVED_TEXT }] : [],
  });
  return [
    { messages: [{ role: "user", content: "Run acceptance" }] },
    {
      messages: [
        assistantMessage(0, acceptanceToolCall(0, target)),
        toolMessage(0, {
          ok: true,
          action: "list_apps",
          apps: [{ name: "TextEdit", bundle_id: "com.apple.TextEdit" }],
        }),
      ],
    },
    {
      messages: [assistantMessage(1, acceptanceToolCall(1, target)), toolMessage(1, windows)],
    },
    {
      messages: [assistantMessage(2, acceptanceToolCall(2, target)), toolMessage(2, capture("ax"))],
    },
    {
      messages: [
        assistantMessage(3, acceptanceToolCall(3, target)),
        toolMessage(3, capture("vision")),
        imageMessage(),
      ],
    },
    {
      messages: [
        assistantMessage(4, acceptanceToolCall(4, target)),
        toolMessage(4, capture("som")),
        imageMessage(),
      ],
    },
    {
      messages: [
        assistantMessage(5, acceptanceToolCall(5, target)),
        toolMessage(5, {
          ok: true,
          action: "type",
          target: resultTarget,
          capture: capture("som"),
        }),
        imageMessage(),
      ],
    },
    {
      messages: [
        assistantMessage(6, acceptanceToolCall(6, target)),
        toolMessage(6, { ok: true, action: "key", target: resultTarget }),
      ],
    },
    {
      messages: [
        assistantMessage(7, acceptanceToolCall(7, target)),
        toolMessage(7, "Element 0 is not present in the latest capture. Capture again."),
      ],
    },
  ];
}

test("packaged acceptance uses a local provider but seeds both Computer Use gates off", () => {
  const capability = "a".repeat(43);
  const fixture = acceptanceFixture(43123, capability, 100);
  assert.equal(fixture.config.providers[0].baseUrl, `http://127.0.0.1:43123/${capability}/v1`);
  assert.equal(fixture.config.providers[0].needsKey, false);
  assert.equal(fixture.config.providers[0].modelMetadata["aiden-cua-acceptance"].vision, true);
  assert.equal(fixture.config.settings.computerUseEnabled, false);
  assert.equal(fixture.chat.computerUseEnabled, false);
  assert.equal(fixture.config.workspaces[0].permission, "none");
});

test("packaged acceptance requires a high-entropy unguessable loopback route", () => {
  const capability = "Aiden_" + "x".repeat(38);
  assert.equal(
    acceptanceCapabilityBaseUrl(43123, capability),
    `http://127.0.0.1:43123/${capability}/v1`,
  );
  assert.equal(acceptanceChatCompletionPath(capability), `/${capability}/v1/chat/completions`);
  assert.throws(() => acceptanceCapabilityBaseUrl(43123, "guessable"), /256 bits/u);
});

test("packaged acceptance loopback rejects requests without the run capability", async () => {
  const capability = "z".repeat(43);
  const model = await startAcceptanceModel({
    capability,
    expectedTitles: [target.title],
    readGates: async () => ({ globalEnabled: true, chatEnabled: true }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
    assert.equal(model.requests.length, 0);
  } finally {
    await model.close();
  }
});

test("TextEdit resolution validates the bundle id and canonical executable", async () => {
  const systemApp = "/System/Applications/TextEdit.app";
  const executable = path.join(systemApp, "Contents", "MacOS", "TextEdit");
  const canonicalized = [];
  assert.equal(
    await resolveTextEditExecutable({
      knownPaths: ["/Applications/Impostor.app", systemApp],
      discover: async () => [],
      canonicalize: async (candidate) => {
        canonicalized.push(candidate);
        return candidate;
      },
      readBundleIdentifier: async (candidate) =>
        candidate === systemApp ? "com.apple.TextEdit" : "example.impostor",
      inspect: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    }),
    executable,
  );
  assert.deepEqual(canonicalized, ["/Applications/Impostor.app", systemApp, executable]);
});

test("TextEdit launcher owns and cleans every process when discovery is ambiguous", async () => {
  const executable = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
  let launched = false;
  let clock = 0;
  let created = [];
  const terminated = [];
  await assert.rejects(
    launchTrackedApplicationProcess({
      executable,
      launch: async () => {
        launched = true;
        created = [
          { pid: 101, command: executable },
          { pid: 102, command: `${executable} document.txt` },
        ];
      },
      listProcesses: async () => (launched ? created : []),
      terminate: async (processInfo) => {
        terminated.push(processInfo.pid);
        created = created.filter((entry) => entry.pid !== processInfo.pid);
      },
      sleep: async () => {
        clock += 1;
      },
      now: () => clock,
      cleanupObservationMs: 1,
    }),
    /multiple new processes/u,
  );
  assert.deepEqual(terminated.sort(), [101, 102]);
});

test("TextEdit launcher cleans a process that appears during timeout cleanup", async () => {
  const executable = "/System/Applications/TextEdit.app/Contents/MacOS/TextEdit";
  let clock = 0;
  let terminated = false;
  await assert.rejects(
    launchTrackedApplicationProcess({
      executable,
      launch: async () => {},
      listProcesses: async () =>
        clock >= 3 && !terminated ? [{ pid: 103, command: executable }] : [],
      terminate: async () => {
        terminated = true;
      },
      sleep: async () => {
        clock += 1;
      },
      now: () => clock,
      timeoutMs: 2,
      cleanupObservationMs: 3,
    }),
    /did not start/u,
  );
  assert.equal(terminated, true);
});

test("Computer Use emergency cleanup signals only exact package-owned helpers", async () => {
  const appPath = "/Applications/Aiden Agent.app";
  const [broker, driver] = computerUseHelperExecutables(appPath);
  const owned = bindOwnedProcesses(
    [
      { pid: 201, command: `${broker} --bridge-fd 4` },
      { pid: 202, command: driver },
      { pid: 203, command: `${broker}-unrelated` },
    ],
    [broker, driver],
  );
  assert.deepEqual(
    owned.map((entry) => entry.pid),
    [201, 202],
  );

  let remaining = [...owned];
  const terminated = [];
  await terminateLingeringComputerUseProcesses(appPath, {
    list: async () => remaining,
    terminate: async (processInfo) => {
      terminated.push(processInfo.pid);
      remaining = remaining.filter((entry) => entry.pid !== processInfo.pid);
    },
    sleep: async () => {},
    now: (() => {
      let tick = 0;
      return () => tick++;
    })(),
    cleanSettleMs: 1,
  });
  assert.deepEqual(terminated, [201, 202]);
});

test("Computer Use emergency cleanup reaps a driver that appears after its broker", async () => {
  const appPath = "/Applications/Aiden Agent.app";
  const [broker, driver] = computerUseHelperExecutables(appPath);
  let clock = 0;
  let stage = "broker";
  const terminated = [];
  await terminateLingeringComputerUseProcesses(appPath, {
    list: async () => {
      if (stage === "broker") return [{ pid: 501, command: broker, executable: broker }];
      if (stage === "driver_pending" && clock >= 1) {
        return [{ pid: 502, command: driver, executable: driver }];
      }
      return [];
    },
    terminate: async (processInfo) => {
      terminated.push(processInfo.pid);
      stage = processInfo.pid === 501 ? "driver_pending" : "clean";
    },
    sleep: async () => {
      clock += 1;
    },
    now: () => clock,
    timeoutMs: 10,
    cleanSettleMs: 2,
  });
  assert.deepEqual(terminated, [501, 502]);
});

test("normal-exit evidence rejects a helper that appears after an empty snapshot", async () => {
  const appPath = "/Applications/Aiden Agent.app";
  const [, driver] = computerUseHelperExecutables(appPath);
  let clock = 0;
  let samples = 0;
  await assert.rejects(
    waitForCleanComputerUseExit(appPath, {
      list: async () => {
        samples += 1;
        return samples === 1 ? [] : [{ pid: 601, command: driver, executable: driver }];
      },
      sleep: async () => {
        clock += 1;
      },
      now: () => clock,
      timeoutMs: 3,
      cleanSettleMs: 2,
    }),
    /remained after packaged Aiden exited/u,
  );
  assert.ok(samples > 1);
});

test("Stop evidence rechecks Aiden after the final awaited helper sample", async () => {
  let clock = 0;
  let samples = 0;
  let exited = false;
  let stopChecks = 0;
  await assert.rejects(
    waitForStopTeardown({
      appPath: "/Applications/Aiden Agent.app",
      childState: {
        promise: new Promise(() => {}),
        outcome: () => (exited ? { code: 0, signal: null } : null),
      },
      model: { waitIssued: Promise.resolve(), requests: [] },
      stopAudit: {
        observed: () => {
          stopChecks += 1;
          return stopChecks > 1;
        },
      },
      deadline: Date.now() + 1_000,
      listHelpers: async () => {
        samples += 1;
        if (samples === 1) return [{ pid: 701 }];
        if (samples === 3) exited = true;
        return [];
      },
      sleep: async () => {
        clock += 1;
      },
      now: () => clock,
      cleanSettleMs: 1,
    }),
    /quit before Stop reaped Computer Use/u,
  );
  assert.equal(samples, 3);
});

test("acceptance failure cleanup terminates Aiden before privileged helpers", async () => {
  const events = [];
  await emergencyCleanup(
    {
      appPath: "/Applications/Aiden Agent.app",
      aidenProcess: { pid: 301 },
      textEditProcess: { pid: 302 },
      model: {},
    },
    {
      terminateProcess: async (processInfo) => events.push(`process:${processInfo.pid}`),
      terminateComputerUse: async () => events.push("computer-use"),
      closeModel: async () => events.push("model"),
    },
  );
  assert.deepEqual(events, ["process:301", "computer-use", "process:302", "model"]);
});

test("packaged acceptance resolves and reuses one exact disposable TextEdit window", () => {
  const requests = successfulRequests();
  assert.deepEqual(resolveAcceptanceTarget(requests[2], [target.title]), target);
  assert.deepEqual(acceptanceToolCall(2, target), {
    action: "capture",
    mode: "ax",
    pid: target.pid,
    window_id: target.window_id,
  });
  assert.throws(
    () =>
      resolveAcceptanceTarget(
        {
          messages: [
            toolMessage(1, {
              ok: true,
              action: "list_windows",
              windows: [target, { ...target, window_id: 789 }],
            }),
          ],
        },
        [target.title],
      ),
    /exactly one disposable TextEdit window/u,
  );
});

test("packaged acceptance scripts captures, two approvals, stale rejection, and cancellation", () => {
  assert.deepEqual(
    Array.from({ length: 9 }, (_, index) => acceptanceToolCall(index, target).action),
    ["list_apps", "list_windows", "capture", "capture", "capture", "type", "key", "click", "wait"],
  );
  assert.equal(acceptanceToolCall(5, target).capture_after, true);
  assert.equal(acceptanceToolCall(5, target).text, ACCEPTANCE_SAVED_TEXT);
  assert.equal(acceptanceToolCall(6, target).keys, "cmd+s");
  assert.equal(acceptanceToolCall(8, target).seconds, 30);
  const chunks = openAiToolCallChunks(5, acceptanceToolCall(5, target));
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].function.name, "computer_use");
  assert.match(chunks[0].choices[0].delta.tool_calls[0].function.arguments, /capture_after/u);
  assert.equal(chunks[1].choices[0].finish_reason, "tool_calls");
});

test("packaged acceptance receipt requires correlated successful tool results", () => {
  const requests = successfulRequests();
  assert.deepEqual(
    evaluateAcceptanceRequests(requests, {
      expectedTitles: [target.title],
      savedText: `prefix ${ACCEPTANCE_SAVED_TEXT}`,
    }).failures,
    [],
  );

  const failed = successfulRequests();
  failed[1] = {
    messages: [
      assistantMessage(0, acceptanceToolCall(0, target)),
      toolMessage(0, "ERROR: list_apps action failed and did not execute"),
    ],
  };
  failed[6] = {
    messages: [
      assistantMessage(5, { action: "type", text: ACCEPTANCE_TEXT, capture_after: true }),
      toolMessage(5, "ERROR: type action was denied"),
      imageMessage(),
    ],
  };
  const result = evaluateAcceptanceRequests(failed, {
    expectedTitles: [target.title],
    savedText: ACCEPTANCE_SAVED_TEXT,
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(" "), /structured success JSON/u);
});

test("packaged acceptance rejects wrong targets, missing images, and unsaved text", () => {
  const requests = successfulRequests();
  requests[3] = {
    messages: [
      assistantMessage(2, acceptanceToolCall(2, target)),
      toolMessage(2, {
        ok: true,
        action: "capture",
        mode: "ax",
        target: { pid: 999, windowId: 456, app: "TextEdit", title: target.title },
      }),
    ],
  };
  requests[4] = { messages: requests[4].messages.filter((message) => message.role !== "user") };
  const result = evaluateAcceptanceRequests(requests, {
    expectedTitles: [target.title],
    savedText: "not saved",
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join(" "), /did not retain|no image|did not contain/u);
});
