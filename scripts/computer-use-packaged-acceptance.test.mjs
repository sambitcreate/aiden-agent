/* global fetch */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_DECOY_INITIAL_TEXT,
  ACCEPTANCE_DENIED_MODEL,
  ACCEPTANCE_DENIED_TEXT,
  ACCEPTANCE_MODEL,
  ACCEPTANCE_SAVED_TEXT,
  ACCEPTANCE_TARGET_INITIAL_TEXT,
  ACCEPTANCE_TEXT,
  ACCEPTANCE_TWO_WINDOW_TOOL_COUNT,
  acceptanceCapabilityBaseUrl,
  acceptanceChatCompletionPath,
  acceptanceDeniedToolCall,
  acceptanceFixture,
  acceptanceGateEvidence,
  acceptanceToolCall,
  applyRunGateFailuresToChecks,
  buildUnsupportedRealDesktopReport,
  classifyAcceptanceError,
  evaluateAcceptanceRequests,
  evaluateDeniedPermissionCheck,
  evaluateHostSupport,
  evaluateRealDesktopReport,
  evaluateStopCleanupCheck,
  evaluateTextEditMarkerCheck,
  evaluateTwoWindowsIsolationCheck,
  openAiToolCallChunks,
  parseMacOSVersion,
  REAL_DESKTOP_CHECK_IDS,
  renderRealDesktopReport,
  resolveAcceptanceTarget,
  resolveAcceptanceWindows,
} from "./computer-use-packaged-acceptance-core.mjs";
import {
  bindOwnedProcesses,
  computerUseHelperExecutables,
  emergencyCleanup,
  launchTrackedApplicationProcess,
  readHostCursorPosition,
  readHostMacOSVersion,
  readPackagedMetadata,
  readTextEditDocumentText,
  resolveTextEditExecutable,
  startAcceptanceModel,
  terminateLingeringComputerUseProcesses,
  waitForCleanComputerUseExit,
  waitForStopTeardown,
} from "./computer-use-packaged-acceptance.mjs";
import { CUA_DRIVER_ARTIFACT_PROVENANCE } from "./computer-use-signing-pins.mjs";

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

test("packaged acceptance uses a local provider, seeds the beta off and the chat ungranted", () => {
  const capability = "a".repeat(43);
  const fixture = acceptanceFixture(43123, capability, 100);
  assert.equal(fixture.config.providers[0].baseUrl, `http://127.0.0.1:43123/${capability}/v1`);
  assert.equal(fixture.config.providers[0].needsKey, false);
  assert.equal(fixture.config.providers[0].modelMetadata["aiden-cua-acceptance"].vision, true);
  assert.equal(fixture.config.settings.computerUseEnabled, false);
  assert.equal(acceptanceGateEvidence(fixture.config, fixture.chat).accessGranted, false);
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
    readGates: async () => ({ globalEnabled: true, accessGranted: true }),
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

test("Computer Use access needs the beta plus a chat grant or Always allow", () => {
  const on = { settings: { computerUseEnabled: true } };
  assert.deepEqual(acceptanceGateEvidence(on, {}), { globalEnabled: true, accessGranted: false });
  assert.deepEqual(acceptanceGateEvidence(on, { computerUseAllowed: true }), {
    globalEnabled: true,
    accessGranted: true,
  });
  assert.equal(
    acceptanceGateEvidence({ settings: { computerUseEnabled: true, computerUseAlwaysAllow: true } }, {})
      .accessGranted,
    true,
  );
  // A grant without the beta never runs.
  assert.deepEqual(
    acceptanceGateEvidence(
      { settings: { computerUseEnabled: false, computerUseAlwaysAllow: true } },
      { computerUseAllowed: true },
    ),
    { globalEnabled: false, accessGranted: false },
  );
});

test("packaged acceptance scripts captures, type and save, stale rejection, and cancellation", () => {
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

const decoy = {
  pid: 123,
  window_id: 789,
  app_name: "TextEdit",
  title: "Aiden CUA Decoy 123.txt",
};

const sampleMetadata = Object.freeze({
  appVersion: "0.69.0",
  driverVersion: CUA_DRIVER_ARTIFACT_PROVENANCE.version,
  macOSVersion: "15.4.1",
});

test("host support classification distinguishes supported macOS, older macOS, and non-macOS hosts", () => {
  assert.deepEqual(parseMacOSVersion("15.4.1"), { major: 15, minor: 4, patch: 1 });
  assert.deepEqual(parseMacOSVersion("14.4"), { major: 14, minor: 4, patch: 0 });
  assert.equal(parseMacOSVersion("unavailable (linux)"), null);

  assert.equal(evaluateHostSupport({ platform: "darwin", macOSVersion: "14.4" }).supported, true);
  assert.equal(evaluateHostSupport({ platform: "darwin", macOSVersion: "15.4.1" }).supported, true);
  assert.equal(evaluateHostSupport({ platform: "darwin", macOSVersion: "26.0" }).supported, true);

  const oldMac = evaluateHostSupport({ platform: "darwin", macOSVersion: "14.3.1" });
  assert.equal(oldMac.supported, false);
  assert.match(oldMac.reason, /14\.4/u);

  const linux = evaluateHostSupport({ platform: "linux", macOSVersion: "unavailable (linux)" });
  assert.equal(linux.supported, false);
  assert.match(linux.reason, /linux/u);

  const unknown = evaluateHostSupport({ platform: "darwin", macOSVersion: "bad" });
  assert.equal(unknown.supported, false);
});

test("TextEdit marker check inspects disk contents rather than trusting tool replies", () => {
  const passed = evaluateTextEditMarkerCheck({
    metadata: sampleMetadata,
    targetFileText: `${ACCEPTANCE_TARGET_INITIAL_TEXT}${ACCEPTANCE_SAVED_TEXT}`,
    targetMatched: true,
  });
  assert.equal(passed.status, "pass");
  assert.equal(passed.driverVersion, CUA_DRIVER_ARTIFACT_PROVENANCE.version);

  const missingMarker = evaluateTextEditMarkerCheck({
    metadata: sampleMetadata,
    targetFileText: `${ACCEPTANCE_TARGET_INITIAL_TEXT}something else`,
    targetMatched: true,
  });
  assert.equal(missingMarker.status, "failed");

  const unchanged = evaluateTextEditMarkerCheck({
    metadata: sampleMetadata,
    targetFileText: ACCEPTANCE_TARGET_INITIAL_TEXT,
    expectedMarker: ACCEPTANCE_TARGET_INITIAL_TEXT,
    targetMatched: true,
  });
  assert.equal(unchanged.status, "failed");

  const wrongTarget = evaluateTextEditMarkerCheck({
    metadata: sampleMetadata,
    targetFileText: `${ACCEPTANCE_TARGET_INITIAL_TEXT}${ACCEPTANCE_SAVED_TEXT}`,
    targetMatched: false,
  });
  assert.equal(wrongTarget.status, "failed");

  const envProblem = evaluateTextEditMarkerCheck({
    metadata: sampleMetadata,
    targetFileText: null,
    environmentError: "TextEdit failed to launch",
  });
  assert.equal(envProblem.status, "environment problem");
});

test("two-window isolation check verifies decoy disk/live invariance and unmoved mouse cursor", () => {
  const baseArgs = {
    metadata: sampleMetadata,
    targetWindow: target,
    decoyWindow: decoy,
    targetFileText: `${ACCEPTANCE_TARGET_INITIAL_TEXT}${ACCEPTANCE_SAVED_TEXT}`,
    decoyFileBefore: ACCEPTANCE_DECOY_INITIAL_TEXT,
    decoyFileAfter: ACCEPTANCE_DECOY_INITIAL_TEXT,
    decoyLiveCaptureText: JSON.stringify({ elements: [{ value: ACCEPTANCE_DECOY_INITIAL_TEXT }] }),
    cursorBefore: { x: 412.5, y: 310.0 },
    cursorAfter: { x: 412.5, y: 310.5 },
  };
  assert.equal(evaluateTwoWindowsIsolationCheck(baseArgs).status, "pass");

  // Decoy file on disk changed -> failed.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyFileAfter: `${ACCEPTANCE_DECOY_INITIAL_TEXT}oops`,
    }).status,
    "failed",
  );

  // Unsaved keystrokes leaked into decoy live AX tree -> failed even though disk file matched.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyLiveCaptureText: JSON.stringify({ elements: [{ value: ACCEPTANCE_SAVED_TEXT }] }),
    }).status,
    "failed",
  );

  // Partial keystroke prefix leakage into decoy live AX tree -> failed.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyLiveCaptureText: JSON.stringify({
        elements: [{ value: `${ACCEPTANCE_DECOY_INITIAL_TEXT}AIDEN_CUA_ACCEPT` }],
      }),
    }).status,
    "failed",
  );

  // Decoy live capture missing the decoy's initial line -> failed.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyLiveCaptureText: JSON.stringify({ elements: [{ value: "something completely unrelated" }] }),
    }).status,
    "failed",
  );

  // Cursor probe failure MUST NOT mask a real decoy tampering failure as an environment problem.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyFileAfter: `${ACCEPTANCE_DECOY_INITIAL_TEXT}tampered`,
      environmentError: "osascript timed out",
    }).status,
    "failed",
  );
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      environmentError: "osascript timed out",
    }).status,
    "environment problem",
  );

  // Host mouse cursor moved during background actions -> failed.
  const moved = evaluateTwoWindowsIsolationCheck({
    ...baseArgs,
    cursorAfter: { x: 440, y: 310 },
  });
  assert.equal(moved.status, "failed");
  assert.match(moved.detail, /cursor moved/iu);

  // Missing or empty live decoy capture fails closed (never counts as pass).
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyLiveCaptureText: null,
    }).status,
    "failed",
  );
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyLiveCaptureText: "   ",
    }).status,
    "failed",
  );

  // Target and decoy belonging to different processes -> failed.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyWindow: { ...decoy, pid: target.pid + 1 },
    }).status,
    "failed",
  );

  // Same window ID for target and decoy -> failed.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      decoyWindow: { ...decoy, window_id: target.window_id },
    }).status,
    "failed",
  );

  // Missing cursor probe -> environment problem, never pass.
  assert.equal(
    evaluateTwoWindowsIsolationCheck({
      ...baseArgs,
      cursorAfter: null,
    }).status,
    "environment problem",
  );
});

test("Stop cleanup check requires observed helper, explicit user Stop, and zero lingering processes", () => {
  assert.equal(
    evaluateStopCleanupCheck({
      metadata: sampleMetadata,
      observedHelperBeforeStop: true,
      observedUserStop: true,
      helpersAfterStop: [],
      helpersAfterQuit: [],
    }).status,
    "pass",
  );
  assert.equal(
    evaluateStopCleanupCheck({
      metadata: sampleMetadata,
      observedHelperBeforeStop: true,
      observedUserStop: true,
      helpersAfterStop: [{ pid: 901 }],
      helpersAfterQuit: [],
    }).status,
    "failed",
  );
  assert.equal(
    evaluateStopCleanupCheck({
      metadata: sampleMetadata,
      observedHelperBeforeStop: true,
      observedUserStop: true,
      helpersAfterStop: [],
      helpersAfterQuit: [{ pid: 902 }],
    }).status,
    "failed",
  );
  assert.equal(
    evaluateStopCleanupCheck({
      metadata: sampleMetadata,
      observedHelperBeforeStop: false,
      observedUserStop: true,
      helpersAfterStop: [],
      helpersAfterQuit: [],
    }).status,
    "failed",
  );
  assert.equal(
    evaluateStopCleanupCheck({
      metadata: sampleMetadata,
      observedHelperBeforeStop: false,
      observedUserStop: false,
      environmentError: "Timed out waiting for operator",
    }).status,
    "environment problem",
  );
});

test("denied permission check verifies refusal and zero disk or window changes", () => {
  const baseArgs = {
    metadata: sampleMetadata,
    deniedResponseText: "The user declined Computer Use in this chat. Do not retry it unless the user asks again.",
    accessGranted: false,
    targetFileBefore: ACCEPTANCE_TARGET_INITIAL_TEXT,
    targetFileAfter: ACCEPTANCE_TARGET_INITIAL_TEXT,
    decoyFileBefore: ACCEPTANCE_DECOY_INITIAL_TEXT,
    decoyFileAfter: ACCEPTANCE_DECOY_INITIAL_TEXT,
    targetWindowTextBefore: ACCEPTANCE_TARGET_INITIAL_TEXT,
    targetWindowTextAfter: ACCEPTANCE_TARGET_INITIAL_TEXT,
  };
  assert.equal(evaluateDeniedPermissionCheck(baseArgs).status, "pass");

  // Also accepts a macOS TCC permission_required refusal when nothing changed.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      deniedResponseText: JSON.stringify({ ok: false, error: { code: "permission_required" } }),
    }).status,
    "pass",
  );

  // Even if the tool said declined, a disk mutation fails the check.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      targetFileAfter: `${ACCEPTANCE_TARGET_INITIAL_TEXT}${ACCEPTANCE_DENIED_TEXT}`,
    }).status,
    "failed",
  );

  // Target window changed in memory despite denial -> failed.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      targetWindowTextAfter: `${ACCEPTANCE_TARGET_INITIAL_TEXT}${ACCEPTANCE_DENIED_TEXT}`,
    }).status,
    "failed",
  );

  // Tool claimed ok: true -> failed.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      deniedResponseText: JSON.stringify({ ok: true, action: "type" }),
    }).status,
    "failed",
  );

  // Denied chat unexpectedly recorded a grant -> failed.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      accessGranted: true,
    }).status,
    "failed",
  );

  // Missing correlated tool result or internal error string containing "denied" MUST fail closed.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      deniedResponseText: "Expected one tool result correlated to aiden-cua-denied-0.",
    }).status,
    "failed",
  );
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      deniedToolResultMissing: true,
    }).status,
    "failed",
  );
  // Echoing the denied marker (which contains "DENIED") without an actual refusal MUST fail closed.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      deniedResponseText: `Typed ${ACCEPTANCE_DENIED_TEXT}`,
    }).status,
    "failed",
  );

  // Missing live TextEdit window snapshot before or after denial MUST fail closed.
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      targetWindowTextBefore: null,
    }).status,
    "failed",
  );
  assert.equal(
    evaluateDeniedPermissionCheck({
      ...baseArgs,
      targetWindowTextAfter: null,
      windowProbeError: "TextEdit document not found",
    }).status,
    "failed",
  );
});

test("real-desktop report evaluator fails closed on missing rows, invalid statuses, and version drift", () => {
  const passingRows = REAL_DESKTOP_CHECK_IDS.map((id) => ({
    id,
    status: "pass",
    detail: "verified",
    ...sampleMetadata,
  }));
  const complete = { schemaVersion: 1, ...sampleMetadata, checks: passingRows };
  const okResult = evaluateRealDesktopReport(complete);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.overallStatus, "pass");
  assert.deepEqual(okResult.missingChecks, []);

  // Missing a single required row NEVER counts as a pass.
  const missingOne = evaluateRealDesktopReport({
    schemaVersion: 1,
    ...sampleMetadata,
    checks: passingRows.slice(0, 3),
  });
  assert.equal(missingOne.ok, false);
  assert.equal(missingOne.overallStatus, "failed");
  assert.deepEqual(missingOne.missingChecks, [REAL_DESKTOP_CHECK_IDS[3]]);
  assert.match(renderRealDesktopReport({ schemaVersion: 1, ...sampleMetadata, checks: passingRows.slice(0, 3) }), /Missing required checks/u);

  // Duplicate row fails closed.
  const duplicate = evaluateRealDesktopReport({
    schemaVersion: 1,
    ...sampleMetadata,
    checks: [...passingRows, passingRows[0]],
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.overallStatus, "failed");

  // Unknown status fails closed.
  const badStatus = evaluateRealDesktopReport({
    schemaVersion: 1,
    ...sampleMetadata,
    checks: passingRows.map((row, index) => (index === 0 ? { ...row, status: "skipped" } : row)),
  });
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.overallStatus, "failed");

  // Version mismatch fails closed.
  const versionDrift = evaluateRealDesktopReport({
    schemaVersion: 1,
    ...sampleMetadata,
    checks: passingRows.map((row, index) => (index === 1 ? { ...row, driverVersion: "0.0.0" } : row)),
  });
  assert.equal(versionDrift.ok, false);
  assert.equal(versionDrift.overallStatus, "failed");

  // Environment problem aggregates cleanly without falsely passing.
  const envReport = evaluateRealDesktopReport({
    schemaVersion: 1,
    ...sampleMetadata,
    checks: passingRows.map((row, index) =>
      index === 2 ? { ...row, status: "environment problem" } : row,
    ),
  });
  assert.equal(envReport.ok, false);
  assert.equal(envReport.overallStatus, "environment problem");

  // Unsupported report marks every check unsupported and carries all three versions.
  const unsupported = buildUnsupportedRealDesktopReport(sampleMetadata, "Host is linux.");
  const unsupportedEval = evaluateRealDesktopReport(unsupported);
  assert.equal(unsupportedEval.ok, false);
  assert.equal(unsupportedEval.overallStatus, "unsupported");
  assert.equal(unsupportedEval.counts.unsupported, REAL_DESKTOP_CHECK_IDS.length);
  const rendered = renderRealDesktopReport(unsupported);
  assert.match(rendered, new RegExp(CUA_DRIVER_ARTIFACT_PROVENANCE.version.replaceAll(".", "\\."), "u"));
  assert.match(rendered, /Overall:\*\* unsupported/u);
});

test("error classifier separates unsupported hosts, environment problems, and product failures", () => {
  assert.equal(classifyAcceptanceError(new Error("Computer Use requires macOS 14.4 or newer")), "unsupported");
  assert.equal(classifyAcceptanceError(new Error("Host platform is linux")), "unsupported");
  assert.equal(classifyAcceptanceError(new Error("Quit every running Aiden window before starting")), "environment problem");
  assert.equal(classifyAcceptanceError(new Error("permission_required: Accessibility")), "environment problem");
  assert.equal(classifyAcceptanceError(new Error("Host mouse cursor moved by 24.0 px")), "failed");
  // Generic driver/product errors must stay "failed", never "unsupported" or "environment problem".
  assert.equal(classifyAcceptanceError(new Error("cua-driver rejected unsupported action 'foo'")), "failed");
  assert.equal(classifyAcceptanceError(new Error("Packaged Computer Use acceptance timed out after 15 minutes.")), "failed");
});

test("run-level gate and evidence failures fold into check rows so the report never prints pass on a failed run", () => {
  const passingRows = REAL_DESKTOP_CHECK_IDS.map((id) => ({
    id,
    status: "pass",
    detail: "verified",
    ...sampleMetadata,
  }));
  const folded = applyRunGateFailuresToChecks(passingRows, {
    issuedCallCount: 8,
    expectedCallCount: ACCEPTANCE_TWO_WINDOW_TOOL_COUNT,
    gateEvidence: { globalEnabled: true, accessGranted: true },
    targetMatched: true,
    evidence: {
      ok: false,
      failures: [
        "Stale element click was not rejected.",
        "Decoy capture did not retain decoy window.",
      ],
    },
  });
  const report = { schemaVersion: 1, ...sampleMetadata, checks: folded };
  const evaluated = evaluateRealDesktopReport(report);
  assert.equal(evaluated.ok, false);
  assert.equal(evaluated.overallStatus, "failed");
  assert.equal(folded.find((row) => row.id === "textedit_saves_marker").status, "failed");
  assert.equal(folded.find((row) => row.id === "two_windows_isolation_and_cursor").status, "failed");
  assert.doesNotMatch(renderRealDesktopReport(report), /Overall:\*\* pass/u);
});

test("TextEdit live document text probe parses JXA output and rejects non-macOS or malformed responses", async () => {
  const text = await readTextEditDocumentText(["Aiden CUA Target.txt", "Aiden CUA Target"], {
    platform: "darwin",
    exec: async (_bin, args) => {
      assert.ok(args.includes("Aiden CUA Target.txt"));
      return { stdout: JSON.stringify({ text: ACCEPTANCE_TARGET_INITIAL_TEXT }) };
    },
  });
  assert.equal(text, ACCEPTANCE_TARGET_INITIAL_TEXT);

  await assert.rejects(
    readTextEditDocumentText(["Aiden CUA Target.txt"], { platform: "linux", exec: async () => ({ stdout: "{}" }) }),
    /macOS-only/u,
  );
  await assert.rejects(
    readTextEditDocumentText(["Aiden CUA Target.txt"], { platform: "darwin", exec: async () => ({ stdout: "not json" }) }),
    /parse live TextEdit document text/u,
  );
});

test("loopback model marks deniedToolResultMissing when denied turn lacks a correlated tool result", async () => {
  const capability = "m".repeat(43);
  const model = await startAcceptanceModel({
    capability,
    expectedTitles: [target.title],
    readGates: async () => ({ globalEnabled: true, accessGranted: true }),
    readDeniedGates: async () => ({ globalEnabled: true, accessGranted: false }),
  });
  const endpoint = `http://127.0.0.1:${model.port}${acceptanceChatCompletionPath(capability)}`;
  try {
    const turn0 = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: ACCEPTANCE_DENIED_MODEL,
        messages: [{ role: "user", content: "Run denied check" }],
      }),
    });
    assert.equal(turn0.status, 200);
    await turn0.text();

    // Turn 1 arrives with NO correlated tool result for aiden-cua-denied-0.
    const turn1 = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: ACCEPTANCE_DENIED_MODEL,
        messages: [{ role: "user", content: "Still no tool result" }],
      }),
    });
    assert.equal(turn1.status, 200);
    await turn1.text();

    assert.equal(model.deniedToolResultMissing(), true);
    assert.equal(model.deniedResponseText(), null);
    assert.equal(
      evaluateDeniedPermissionCheck({
        metadata: sampleMetadata,
        deniedResponseText: model.deniedResponseText(),
        deniedToolResultMissing: model.deniedToolResultMissing(),
        accessGranted: false,
        targetFileBefore: ACCEPTANCE_TARGET_INITIAL_TEXT,
        targetFileAfter: ACCEPTANCE_TARGET_INITIAL_TEXT,
        decoyFileBefore: ACCEPTANCE_DECOY_INITIAL_TEXT,
        decoyFileAfter: ACCEPTANCE_DECOY_INITIAL_TEXT,
        targetWindowTextBefore: ACCEPTANCE_TARGET_INITIAL_TEXT,
        targetWindowTextAfter: ACCEPTANCE_TARGET_INITIAL_TEXT,
      }).status,
      "failed",
    );
  } finally {
    await model.close();
  }
});

test("cursor and metadata probes parse macOS output and reject invalid or non-macOS responses", async () => {
  const pos = await readHostCursorPosition({
    platform: "darwin",
    exec: async () => ({ stdout: '{"x":512.25,"y":280.5}\n' }),
  });
  assert.deepEqual(pos, { x: 512.25, y: 280.5 });

  await assert.rejects(
    readHostCursorPosition({ platform: "linux", exec: async () => ({ stdout: "{}" }) }),
    /macOS-only/u,
  );
  await assert.rejects(
    readHostCursorPosition({ platform: "darwin", exec: async () => ({ stdout: "not json" }) }),
    /parse host mouse cursor/u,
  );

  assert.equal(
    await readHostMacOSVersion({ platform: "darwin", exec: async () => ({ stdout: "15.4.1\n" }) }),
    "15.4.1",
  );
  assert.equal(await readHostMacOSVersion({ platform: "linux" }), "unavailable (linux)");

  const meta = await readPackagedMetadata({
    root: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    platform: "darwin",
    exec: async () => ({ stdout: "15.4.1\n" }),
  });
  assert.equal(meta.driverVersion, CUA_DRIVER_ARTIFACT_PROVENANCE.version);
  assert.equal(meta.macOSVersion, "15.4.1");
  assert.match(meta.appVersion, /^\d+\.\d+\.\d+/u);
});

test("two-window and denied-chat loopback sequence samples cursor around background mutations and captures decoy", async () => {
  const capability = "k".repeat(43);
  const sampled = [];
  let deniedObserved = false;
  const model = await startAcceptanceModel({
    capability,
    expectedTitles: [target.title],
    decoyTitles: [decoy.title],
    readGates: async () => ({ globalEnabled: true, accessGranted: true }),
    readDeniedGates: async () => ({ globalEnabled: true, accessGranted: false }),
    onDeniedObserved: async () => {
      deniedObserved = true;
    },
    onSampleCursor: async (phase) => {
      sampled.push(phase);
      return { x: 300, y: 200 };
    },
  });
  const endpoint = `http://127.0.0.1:${model.port}${acceptanceChatCompletionPath(capability)}`;
  const post = async (body) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  try {
    // 1. Denied chat: model issues type with ACCEPTANCE_DENIED_TEXT, then records refusal.
    const deniedTurn0 = await post({
      model: ACCEPTANCE_DENIED_MODEL,
      messages: [{ role: "user", content: "Run denied check" }],
    });
    assert.match(deniedTurn0, new RegExp(ACCEPTANCE_DENIED_TEXT, "u"));
    assert.deepEqual(acceptanceDeniedToolCall(0), {
      action: "type",
      text: ACCEPTANCE_DENIED_TEXT,
      capture_after: false,
    });
    const deniedTurn1 = await post({
      model: ACCEPTANCE_DENIED_MODEL,
      messages: [
        {
          role: "tool",
          tool_call_id: "aiden-cua-denied-0",
          content: "The user declined Computer Use in this chat.",
        },
      ],
    });
    assert.match(deniedTurn1, /Denied check complete/u);
    assert.equal(deniedObserved, true);
    assert.equal(model.deniedResponseText(), "The user declined Computer Use in this chat.");
    assert.equal(model.deniedGateEvidence()?.accessGranted, false);

    // 2. Allowed chat with two windows: verify target + decoy resolution, cursor sampling, decoy capture, wait.
    const twoWindowReqs = successfulRequests();
    twoWindowReqs[2] = {
      messages: [
        assistantMessage(1, acceptanceToolCall(1, target, decoy)),
        toolMessage(1, { ok: true, action: "list_windows", windows: [target, decoy] }),
      ],
    };
    const decoyTarget = {
      pid: decoy.pid,
      windowId: decoy.window_id,
      app: decoy.app_name,
      title: decoy.title,
    };
    twoWindowReqs.push({
      messages: [
        assistantMessage(8, acceptanceToolCall(8, target, decoy)),
        toolMessage(8, {
          ok: true,
          action: "capture",
          mode: "ax",
          target: decoyTarget,
          elements: [{ value: ACCEPTANCE_DECOY_INITIAL_TEXT }],
        }),
      ],
    });
    assert.equal(twoWindowReqs.length, ACCEPTANCE_TWO_WINDOW_TOOL_COUNT);
    assert.deepEqual(
      resolveAcceptanceWindows(twoWindowReqs[2], {
        targetTitles: [target.title],
        decoyTitles: [decoy.title],
      }),
      { target, decoy },
    );

    for (const req of twoWindowReqs) {
      await post({ model: ACCEPTANCE_MODEL, ...req });
    }
    await model.waitIssued;
    assert.deepEqual(sampled, ["before", "after"]);
    assert.deepEqual(model.cursorSamples(), { before: { x: 300, y: 200 }, after: { x: 300, y: 200 } });
    assert.deepEqual(model.decoy(), decoy);
    assert.equal(model.issuedCalls[8].action, "capture");
    assert.equal(model.issuedCalls[8].window_id, decoy.window_id);
    assert.equal(model.issuedCalls[9].action, "wait");

    const evalResult = evaluateAcceptanceRequests(twoWindowReqs, {
      expectedTitles: [target.title],
      decoyTitles: [decoy.title],
      savedText: `${ACCEPTANCE_TARGET_INITIAL_TEXT}${ACCEPTANCE_SAVED_TEXT}`,
      decoySavedText: ACCEPTANCE_DECOY_INITIAL_TEXT,
    });
    assert.deepEqual(evalResult.failures, []);
    assert.equal(evalResult.ok, true);
  } finally {
    await model.close();
  }
});
