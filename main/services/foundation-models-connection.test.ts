import assert from "node:assert/strict";
import test from "node:test";
import {
  FoundationModelsConnectionError,
  createFoundationModelsConnection,
  parseFoundationModelsResponse,
  platformFoundationModelsStatus,
  stopRecordedHelperProcess,
} from "./foundation-models-connection-core.js";

test("omits the Apple connection away from macOS", () => {
  assert.equal(
    platformFoundationModelsStatus({ platform: "linux", arch: "arm64", systemVersion: "26.0" }),
    null,
  );
});

test("reports OS and hardware gates before invoking the helper", () => {
  assert.equal(
    platformFoundationModelsStatus({ platform: "darwin", arch: "arm64", systemVersion: "25.6" })?.state,
    "unsupported_os",
  );
  assert.equal(
    platformFoundationModelsStatus({ platform: "darwin", arch: "x64", systemVersion: "26.0" })?.state,
    "device_not_eligible",
  );
  assert.equal(
    platformFoundationModelsStatus({ platform: "darwin", arch: "arm64", systemVersion: "26.0" }),
    undefined,
  );
});

test("validates the native response envelope", () => {
  assert.deepEqual(
    parseFoundationModelsResponse('{"version":1,"ok":true,"result":{"state":"ready"}}'),
    { version: 1, ok: true, result: { state: "ready" } },
  );
  assert.throws(() => parseFoundationModelsResponse("not json"), /invalid JSON/);
  assert.throws(() => parseFoundationModelsResponse('{"version":2,"ok":true}'), /protocol/);
  assert.throws(
    () => parseFoundationModelsResponse('{"version":1,"ok":true,"result":{"state":"future"}}'),
    /availability state/,
  );
  assert.throws(
    () => parseFoundationModelsResponse('{"version":1,"ok":false,"error":{"code":2}}'),
    /error details/,
  );
});

test("deduplicates and caches status reads", async () => {
  let now = 1_000;
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const connection = createFoundationModelsConnection({
    platform: "darwin",
    arch: "arm64",
    systemVersion: "26.0",
    now: () => now,
    runRequest: async () => {
      calls += 1;
      await blocked;
      return { version: 1, ok: true, result: { state: "ready" } };
    },
  });

  const first = connection.status();
  const second = connection.status();
  release();
  assert.equal((await first)?.state, "ready");
  assert.equal((await second)?.state, "ready");
  assert.equal(calls, 1);

  assert.equal((await connection.status())?.state, "ready");
  assert.equal(calls, 1);
  now += 31_000;
  assert.equal((await connection.status())?.state, "ready");
  assert.equal(calls, 2);
});

test("maps helper availability states and title errors", async () => {
  const responses = [
    { version: 1, ok: true, result: { state: "apple_intelligence_disabled" as const } },
    {
      version: 1,
      ok: false,
      error: { code: "rate_limited", message: "Try later.", retryable: true },
    },
  ];
  const connection = createFoundationModelsConnection({
    platform: "darwin",
    arch: "arm64",
    systemVersion: "26.0",
    now: Date.now,
    runRequest: async () => responses.shift()!,
  });

  assert.equal((await connection.status())?.state, "apple_intelligence_disabled");
  await assert.rejects(
    connection.generateTitle("Name this chat"),
    (error: unknown) =>
      error instanceof FoundationModelsConnectionError &&
      error.code === "rate_limited" &&
      error.retryable,
  );
});

test("downgrades cached readiness after a native availability failure", async () => {
  let calls = 0;
  const connection = createFoundationModelsConnection({
    platform: "darwin",
    arch: "arm64",
    systemVersion: "26.0",
    now: () => 1_000,
    runRequest: async (request) => {
      calls += 1;
      if (request.method === "availability") {
        return { version: 1, ok: true, result: { state: "ready" } };
      }
      return {
        version: 1,
        ok: false,
        error: {
          code: "assets_unavailable",
          message: "The on-device model is temporarily unavailable.",
          retryable: true,
        },
      };
    },
  });

  assert.equal((await connection.status())?.state, "ready");
  await assert.rejects(connection.generateTitle("Name this chat"), /temporarily unavailable/);
  assert.equal((await connection.status())?.state, "unavailable");
  assert.equal(calls, 2);
});

test("stopping the helper never signals a process that reused its recorded PID", async () => {
  const helperApp = "/Applications/Aiden.app/Contents/Helpers/Aiden Foundation Models Helper.app";
  const running = new Map<number, string>([
    [4242, `${helperApp}/Contents/MacOS/Aiden Foundation Models Helper`],
    [5151, "/usr/bin/vim"],
    [6161, `${helperApp}.evil/Contents/MacOS/payload`],
  ]);
  const signalled: Array<[number, string]> = [];
  const dependencies = {
    readExecutable: async (pid: number) => running.get(pid) ?? null,
    kill: (pid: number, signal: NodeJS.Signals) => {
      signalled.push([pid, signal]);
    },
  };

  assert.equal(await stopRecordedHelperProcess("4242\n", helperApp, dependencies), true);
  assert.equal(await stopRecordedHelperProcess("5151", helperApp, dependencies), false);
  assert.equal(await stopRecordedHelperProcess("6161", helperApp, dependencies), false);
  assert.equal(await stopRecordedHelperProcess("7171", helperApp, dependencies), false, "an exited helper");
  assert.equal(await stopRecordedHelperProcess("1", helperApp, dependencies), false);
  assert.equal(await stopRecordedHelperProcess("42abc", helperApp, dependencies), false);
  assert.deepEqual(signalled, [[4242, "SIGTERM"]]);
});
