import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  ANDROID_RECORDING_MAX_MS,
  DEVICE_CLIPBOARD_MAX_BYTES,
  type DeviceFeatureTarget,
} from "../../../renderer/shared/device-features.js";
import type { DeviceServiceState, DeviceSummary } from "../../../renderer/shared/devices.js";
import {
  ANDROID_ERASE_TIMEOUT_MS,
  ANDROID_TEXT_CHUNK_BYTES,
  androidPullCommand,
  androidRecordingRemotePath,
  androidRemoveRemoteFileCommand,
  androidScreenrecordCommand,
  androidStopScreenrecordCommand,
  androidWipeBootCommand,
  chunkDeviceText,
  eraseAndroidEmulator,
  freeEmulatorPort,
  type AndroidErasePhase,
} from "./android-device-feature-actions.js";
import type { DeviceCommandOptions, DeviceCommandResult, DeviceHostReady } from "./device-host.js";
import { createDeviceFeatures, type DeviceFeaturePort } from "./device-features.js";
import { createDeviceRecorder, type RecorderChild } from "./device-recording.js";

const SERIAL = "emulator-5554";
const AVD = "Pixel_9_API_36";
const REC_ID = "rec_ABCDEFGH12";

/** What the device's own `sh` would see as argv after `adb shell` joins the words with spaces. */
function deviceArgv(words: readonly string[]): string[] {
  const script = 'for a in "$@"; do printf "%s\\0" "$a"; done';
  const result = spawnSync(
    "/bin/sh",
    ["-c", `eval "set -- ${words.join(" ").replace(/["\\$`]/gu, "\\$&")}"; ${script}`],
    {
      encoding: "utf8",
    },
  );
  return result.stdout.split("\0").slice(0, -1);
}

const shellWords = (command: { args: string[] }) =>
  command.args.slice(command.args.indexOf("shell") + 1);

test("recording argv: screenrecord, a targeted stop, pull, and remove, all scoped to one serial and one file", () => {
  const remote = androidRecordingRemotePath(REC_ID);
  assert.equal(remote, `/sdcard/aiden-rec-${REC_ID}.mp4`);
  assert.throws(() => androidRecordingRemotePath("x; rm -rf /sdcard"), /valid recording/u);

  const record = androidScreenrecordCommand(SERIAL, remote);
  assert.equal(record.command, "adb");
  assert.deepEqual(record.args.slice(0, 3), ["-s", SERIAL, "shell"]);
  assert.deepEqual(deviceArgv(shellWords(record)), ["screenrecord", "--time-limit", "180", remote]);
  // Older images refuse anything past 180 s, so a longer request is clamped.
  assert.deepEqual(
    deviceArgv(shellWords(androidScreenrecordCommand(SERIAL, remote, 600))).slice(1, 3),
    ["--time-limit", "180"],
  );

  // The stop signals only the recorder writing this file, and the device shell reads the pattern as one word.
  assert.deepEqual(deviceArgv(shellWords(androidStopScreenrecordCommand(SERIAL, remote))), [
    "pkill",
    "-INT",
    "-f",
    remote,
  ]);
  assert.deepEqual(deviceArgv(shellWords(androidRemoveRemoteFileCommand(SERIAL, remote))), [
    "rm",
    "-f",
    remote,
  ]);

  // `adb pull` never reaches a device shell, so a local path with spaces stays one argv entry.
  const local = "/Users/me/Library/Application Support/Aiden/devices/recordings/a b.mp4";
  assert.deepEqual(androidPullCommand(SERIAL, remote, local), {
    command: "adb",
    args: ["-s", SERIAL, "pull", remote, local],
  });
});

test("erase boots the AVD once with -wipe-data on a port no emulator uses", () => {
  assert.deepEqual(androidWipeBootCommand(AVD, 5558), {
    command: "emulator",
    args: [
      "-avd",
      AVD,
      "-wipe-data",
      "-no-snapshot-load",
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-port",
      "5558",
    ],
  });
  assert.throws(() => androidWipeBootCommand("-wipe-data", 5554), /valid Android Virtual Device/u);
  assert.throws(() => androidWipeBootCommand("a b", 5554), /valid Android Virtual Device/u);

  const listed = [
    "List of devices attached",
    "emulator-5554\tdevice",
    "emulator-5556\toffline",
    "54241FDCQ00033\tdevice",
    "",
  ].join("\n");
  assert.equal(freeEmulatorPort(listed), 5558);
  assert.equal(freeEmulatorPort("List of devices attached\n"), 5554);
  assert.equal(freeEmulatorPort("emulator-5554\tdevice\n", [5554]), null);
});

test("paste text is split into serve-emu-sized pieces without breaking a character", () => {
  const ascii = "a".repeat(650);
  assert.deepEqual(
    chunkDeviceText(ascii).map((piece) => piece.length),
    [300, 300, 50],
  );
  const mixed = `${"😀".repeat(80)}héllo ${"界".repeat(120)}`;
  const pieces = chunkDeviceText(mixed);
  const encoder = new TextEncoder();
  assert.equal(pieces.join(""), mixed, "nothing is lost or reordered");
  for (const piece of pieces) {
    assert.ok(encoder.encode(piece).byteLength <= ANDROID_TEXT_CHUNK_BYTES);
    // A split inside a surrogate pair would leave a lone surrogate, which is not well-formed.
    assert.equal(Buffer.from(piece, "utf8").toString("utf8"), piece);
  }
  assert.deepEqual(chunkDeviceText(""), []);
});

// ── The erase state machine ─────────────────────────────────────────────────

interface EraseScript {
  /** Output of each wipe boot that exits by itself, in order; a missing entry boots normally. */
  wipeExits?: Array<{ code: number; stderr: string }>;
  /** getprop polls before the boot completes. */
  bootPolls?: number;
  neverBoots?: boolean;
  shutdownFails?: boolean;
}

function eraseHarness(script: EraseScript = {}) {
  let clock = 0;
  const log: string[] = [];
  const phases: AndroidErasePhase[] = [];
  let wipeRuns = 0;
  let polls = 0;
  let exitRunning: ((result: DeviceCommandResult) => void) | null = null;
  const run = (
    command: string,
    args: readonly string[],
    _options?: DeviceCommandOptions,
  ): Promise<DeviceCommandResult> => {
    log.push([command, ...args].join(" "));
    const ok = (stdout = ""): Promise<DeviceCommandResult> =>
      Promise.resolve({ stdout, stderr: "", code: 0 });
    if (command === "adb" && args[0] === "devices")
      return ok("List of devices attached\nemulator-5554\tdevice\n");
    if (command === "emulator") {
      const scripted = script.wipeExits?.[wipeRuns++];
      if (scripted) return Promise.resolve({ stdout: "", ...scripted });
      return new Promise((resolve) => {
        exitRunning = resolve;
      });
    }
    if (args.includes("getprop")) {
      polls += 1;
      // Only a wipe boot that is still running can report a finished boot.
      return ok(
        exitRunning && !script.neverBoots && polls > (script.bootPolls ?? 0) ? "1\n" : "\n",
      );
    }
    if (args.includes("emu") && args.includes("kill")) {
      // The console answers, then the emulator process exits.
      queueMicrotask(() => exitRunning?.({ stdout: "", stderr: "", code: 0 }));
      return ok("OK: killing emulator, bye bye\nOK\n");
    }
    return ok();
  };
  const deps = {
    run,
    shutdown: async () => {
      log.push("hub shutdown");
      if (script.shutdownFails)
        throw new Error("emulator-5554 did not exit within 30s of the shutdown");
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, log, phases, onPhase: (phase: AndroidErasePhase) => phases.push(phase) };
}

test("erasing a running emulator shuts it down through the hub, wipe-boots it, and stops it once booted", async () => {
  const h = eraseHarness({ bootPolls: 2 });
  await eraseAndroidEmulator(h.deps, { avdName: AVD, booted: true }, h.onPhase);
  assert.deepEqual(h.phases, ["shutting-down", "erasing", "erased"]);
  const wipe = h.log.findIndex((line) => line.startsWith("emulator "));
  assert.ok(
    h.log.indexOf("hub shutdown") < wipe,
    "the wipe never starts before the shutdown finished",
  );
  // The original emulator still holds 5554, so the wipe boot takes the next console port.
  assert.equal(
    h.log[wipe],
    `emulator -avd ${AVD} -wipe-data -no-snapshot-load -no-window -no-audio -no-boot-anim -port 5556`,
  );
  const polls = h.log.filter(
    (line) => line === "adb -s emulator-5556 shell getprop sys.boot_completed",
  );
  assert.equal(polls.length, 3);
  assert.equal(
    h.log[h.log.length - 1],
    "adb -s emulator-5556 emu kill",
    "it exits only after Android finished booting",
  );
});

test("a stopped AVD is wiped without a shutdown, and a failed shutdown never wipes", async () => {
  const off = eraseHarness();
  await eraseAndroidEmulator(off.deps, { avdName: AVD, booted: false }, off.onPhase);
  assert.deepEqual(off.phases, ["erasing", "erased"]);
  assert.equal(off.log.includes("hub shutdown"), false);

  const stuck = eraseHarness({ shutdownFails: true });
  await assert.rejects(
    eraseAndroidEmulator(stuck.deps, { avdName: AVD, booted: true }, stuck.onPhase),
    /did not shut down, so it was not erased: emulator-5554 did not exit/u,
  );
  assert.equal(
    stuck.log.some((line) => line.startsWith("emulator ")),
    false,
  );
});

test("a wipe boot waits while the old emulator still holds the AVD, and reports any other failure", async () => {
  const locked = eraseHarness({
    wipeExits: [
      {
        code: 1,
        stderr:
          "FATAL        | Running multiple emulators with the same AVD is an experimental feature.Please use -read-only flag to enable this feature.",
      },
    ],
  });
  await eraseAndroidEmulator(locked.deps, { avdName: AVD, booted: false }, locked.onPhase);
  assert.equal(locked.log.filter((line) => line.startsWith("emulator ")).length, 2);
  assert.deepEqual(locked.phases, ["erasing", "erased"]);

  const broken = eraseHarness({
    wipeExits: [{ code: 1, stderr: "FATAL        | Unknown AVD name [Pixel_9_API_36]" }],
  });
  await assert.rejects(
    eraseAndroidEmulator(broken.deps, { avdName: AVD, booted: false }, broken.onPhase),
    /could not be erased: Unknown AVD name \[Pixel_9_API_36\]/u,
  );
  assert.equal(broken.log.filter((line) => line.startsWith("emulator ")).length, 1);
  assert.deepEqual(broken.phases, ["erasing"]);
});

test("a wipe boot that never finishes is stopped at the deadline", async () => {
  const h = eraseHarness({ neverBoots: true });
  await assert.rejects(
    eraseAndroidEmulator(h.deps, { avdName: AVD, booted: false }, h.onPhase),
    /did not finish erasing in time/u,
  );
  assert.equal(h.log[h.log.length - 1], "adb -s emulator-5556 emu kill");
  assert.ok(
    h.log.filter((line) => line.includes("getprop")).length <= ANDROID_ERASE_TIMEOUT_MS / 2_000 + 1,
  );
});

// ── Features on an Android emulator ─────────────────────────────────────────

class AdbChild implements RecorderChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  private listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  constructor(
    readonly args: readonly string[],
    readonly env: NodeJS.ProcessEnv | undefined,
  ) {}
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.exit(null, "SIGKILL");
    return true;
  }
  once(_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
    this.listeners.push(listener);
    return this;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of this.listeners.splice(0)) listener(code, signal);
  }
}

function androidHarness(
  options: { booted?: boolean; hostText?: string; ignoreStop?: boolean; pullFails?: boolean } = {},
) {
  const device: DeviceSummary = {
    hostId: "local",
    id: options.booted === false ? AVD : SERIAL,
    name: AVD,
    platform: "android",
    version: "Android 16",
    booted: options.booted ?? true,
    kind: "other",
  };
  const target: DeviceFeatureTarget = { platform: "android", hostId: "local", deviceId: device.id };
  let state: DeviceServiceState = {
    hostStatus: "ready",
    hostStatuses: { local: { status: "ready" } },
    hosts: [{ id: "local", kind: "local", name: "This Mac", status: "ready" }],
    consent: { streaming: true, agentAccess: false, peerSharing: false },
    devices: [device],
    sessions: [],
    toolVersions: { hub: "0.12.0", agent: "0.21.12" },
  };
  const stateListeners = new Set<(state: DeviceServiceState) => void>();
  const setState = (next: Partial<DeviceServiceState>) => {
    state = { ...state, ...next };
    for (const listener of stateListeners) listener(state);
  };
  /** Files on this Mac and on the emulator. */
  const files = new Map<string, Uint8Array | string>();
  const remoteFiles = new Map<string, string>();
  const commands: string[] = [];
  const events: string[] = [];
  const children: AdbChild[] = [];
  const posts: Array<{ url: string; body: unknown }> = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 1_000;
  let nextTimer = 1;

  let wipeExit: ((result: DeviceCommandResult) => void) | null = null;
  const run: DeviceHostReady["run"] = async (command, args) => {
    const line = [command, ...args].join(" ");
    commands.push(line);
    // The wipe boot runs until its console is asked to exit.
    if (command === "emulator") return new Promise((resolve) => (wipeExit = resolve));
    if (args.includes("emu") && args.includes("kill")) {
      queueMicrotask(() => wipeExit?.({ stdout: "", stderr: "", code: 0 }));
      return { stdout: "OK", stderr: "", code: 0 };
    }
    if (args.includes("getprop")) return { stdout: "1\n", stderr: "", code: 0 };
    const shell = args.indexOf("shell");
    const words = shell >= 0 ? deviceArgv(args.slice(shell + 1)) : [];
    if (words[0] === "pkill") {
      const path = words[3]!;
      const child = children.find(
        (candidate) =>
          candidate.args[candidate.args.length - 1] === path && candidate.exitCode === null,
      );
      if (child && !options.ignoreStop) {
        // screenrecord writes the MP4 index, then the local `adb shell` exits cleanly.
        remoteFiles.set(path, "mp4");
        queueMicrotask(() => child.exit(0));
      }
      return { stdout: "", stderr: "", code: child ? 0 : 1 };
    }
    if (words[0] === "rm") {
      remoteFiles.delete(words[2]!);
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[2] === "pull") {
      const [remote, local] = [args[3]!, args[4]!];
      if (options.pullFails || !remoteFiles.has(remote)) {
        return {
          stdout: "",
          stderr: `adb: error: failed to stat remote object '${remote}'`,
          code: 1,
        };
      }
      files.set(local, remoteFiles.get(remote)!);
      return { stdout: "1 file pulled", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const ready: DeviceHostReady = {
    nodePath: "/node",
    hub: { origin: "http://127.0.0.1:4100" },
    helpers: { axSettings: null, serveSimCli: null },
    run,
    env: { PATH: "/sdk/platform-tools:/usr/bin" },
  };
  const service: DeviceFeaturePort = {
    async localTarget(input) {
      if (input.hostId !== "local") throw new Error("This works only with simulators on this Mac.");
      const found = state.devices.find((candidate) => candidate.id === input.deviceId);
      if (!found) throw new Error("That simulator is no longer available.");
      if (input.booted && !found.booted) throw new Error("Open the simulator first.");
      return { ready, device: found };
    },
    async refreshLocal() {
      events.push("refresh");
      return state;
    },
    state: () => state,
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    async screenshot(input) {
      events.push(`screenshot:${input.deviceId}`);
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    },
    async shutdownLocal(input) {
      events.push(`shutdown:${input.deviceId}`);
    },
  };
  let ids = 0;
  const recorder = createDeviceRecorder({
    spawn: (_command, args, env) => {
      const child = new AdbChild(args, env);
      children.push(child);
      return child;
    },
    tempDir: async () => "/private/recordings",
    fileSize: async (file) => (files.has(file) ? 4096 : null),
    removeFile: async (file) => {
      files.delete(file);
    },
    newId: () => `rec_${String(++ids).padStart(8, "0")}`,
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  const host = { text: options.hostText ?? "hello", written: [] as string[] };
  const features = createDeviceFeatures({
    service,
    recorder,
    clipboard: {
      readText: () => host.text,
      availableFormats: () => (host.text ? ["text/plain"] : []),
      writeText: (text) => host.written.push(text),
    },
    moveFile: async (from, to) => {
      const bytes = files.get(from);
      if (bytes === undefined) throw new Error("missing temp file");
      files.delete(from);
      files.set(to, bytes);
    },
    removeFile: async (file) => {
      files.delete(file);
    },
    writeFile: async (file, bytes) => {
      files.set(file, bytes);
    },
    now: () => new Date(2026, 9, 8, 9, 30, 0),
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
    sleep: async () => undefined,
  });
  return {
    features,
    target,
    device,
    commands,
    events,
    children,
    files,
    remoteFiles,
    posts,
    host,
    advance,
    setState,
  };
}

const flush = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
};

test("an emulator recording stops on the device, is pulled into the temp file, and its device copy is deleted", async () => {
  const h = androidHarness();
  const started = await h.features.startRecording("chat-1", h.target);
  assert.equal(
    started.endsBy - started.startedAt,
    ANDROID_RECORDING_MAX_MS,
    "Android recordings stop at three minutes",
  );
  const child = h.children[0]!;
  const remote = androidRecordingRemotePath(started.id);
  assert.deepEqual(
    [...child.args],
    ["-s", SERIAL, "shell", "screenrecord", "--time-limit", "180", remote],
  );
  assert.equal(child.env?.PATH, "/sdk/platform-tools:/usr/bin", "adb runs with the SDK on PATH");

  const stopped = await h.features.stopRecording(started.id);
  assert.equal(stopped.status, "ready");
  assert.deepEqual(
    child.signals,
    [],
    "the local adb is never signalled; the device's recorder finalizes",
  );
  const local = `/private/recordings/${started.id}.mp4`;
  assert.equal(h.files.get(local), "mp4");
  assert.equal(h.remoteFiles.size, 0, "the emulator's copy is deleted");
  const stop = h.commands.indexOf(`adb -s ${SERIAL} shell pkill -INT -f ${remote}`);
  const pull = h.commands.indexOf(`adb -s ${SERIAL} pull ${remote} ${local}`);
  const remove = h.commands.indexOf(`adb -s ${SERIAL} shell rm -f ${remote}`);
  assert.ok(
    stop >= 0 && stop < pull && pull < remove,
    "stop, then pull, then delete the device copy",
  );

  const saved = await h.features.saveRecording(started.id, async (name) => {
    assert.match(name, /^Pixel_9_API_36-\d{4}-\d{2}-\d{2}-\d{6}\.mp4$/u);
    return "/Users/me/Downloads/emu.mp4";
  });
  assert.deepEqual(saved, { status: "saved", path: "/Users/me/Downloads/emu.mp4" });
});

test("an emulator recording that reaches screenrecord's own limit is still pulled and cleaned up", async () => {
  const h = androidHarness();
  const started = await h.features.startRecording("chat-1", h.target);
  const remote = androidRecordingRemotePath(started.id);
  h.remoteFiles.set(remote, "mp4");
  h.children[0]!.exit(0);
  await flush();
  const info = h.features.recordings()[0]!;
  assert.equal(info.status, "ready");
  assert.equal(h.remoteFiles.size, 0);
  assert.equal(h.files.has(`/private/recordings/${started.id}.mp4`), true);
});

test("an emulator recording fails cleanly when its file cannot be pulled or its recorder ignores the stop", async () => {
  const unpulled = androidHarness({ pullFails: true });
  const first = await unpulled.features.startRecording("chat-1", unpulled.target);
  const failed = await unpulled.features.stopRecording(first.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /could not be copied from the emulator/u);
  assert.equal(
    unpulled.remoteFiles.size,
    0,
    "the device copy is removed even when the pull failed",
  );

  const hung = androidHarness({ ignoreStop: true });
  const second = await hung.features.startRecording("chat-1", hung.target);
  const stopping = hung.features.stopRecording(second.id);
  await flush();
  hung.advance(15_000);
  const timedOut = await stopping;
  assert.equal(timedOut.status, "failed");
  assert.deepEqual(hung.children[0]!.signals, ["SIGKILL"]);
  const rm = hung.commands.filter((line) =>
    line.endsWith(`rm -f ${androidRecordingRemotePath(second.id)}`),
  );
  assert.equal(rm.length, 1, "a killed recording still deletes its device copy");
});

test("a deleted chat, a shut-down emulator, and app quit each stop and delete emulator recordings", async () => {
  const h = androidHarness();
  await h.features.startRecording("chat-1", h.target);
  await h.features.discardForChat("chat-1");
  assert.deepEqual(h.features.recordings(), []);
  assert.equal(h.remoteFiles.size, 0);
  assert.equal(h.files.size, 0, "the pulled temp file is deleted too");

  await h.features.startRecording("chat-2", h.target);
  h.setState({ devices: [{ ...h.device, booted: false }] });
  await flush();
  assert.deepEqual(h.features.recordings(), []);
  assert.equal(h.remoteFiles.size, 0);

  h.setState({ devices: [h.device] });
  await h.features.startRecording("chat-3", h.target);
  await h.features.stop();
  assert.deepEqual(h.features.recordings(), []);
  assert.equal(h.remoteFiles.size + h.files.size, 0);
});

test("paste types the host clipboard into the emulator through serve-emu, in pieces, capped at 64 KB", async () => {
  const text = `${"x".repeat(299)}é${"y".repeat(400)}`;
  const h = androidHarness({ hostText: text });
  assert.deepEqual(await h.features.pasteFromHost(h.target), {
    bytes: new TextEncoder().encode(text).byteLength,
  });
  assert.ok(h.posts.length >= 3);
  for (const post of h.posts)
    assert.equal(post.url, `http://127.0.0.1:4100/vendor/serve-emu/api/text?device=${SERIAL}`);
  assert.equal(h.posts.map((post) => (post.body as { text: string }).text).join(""), text);

  const huge = androidHarness({ hostText: "z".repeat(DEVICE_CLIPBOARD_MAX_BYTES + 1) });
  await assert.rejects(huge.features.pasteFromHost(huge.target), /larger than 64 KB/u);
  assert.equal(huge.posts.length, 0);

  const off = androidHarness({ booted: false });
  await assert.rejects(off.features.pasteFromHost(off.target), /Open the simulator first/u);
});

test("copying from an emulator is refused with the reason, and nothing reaches the host clipboard", async () => {
  const h = androidHarness();
  await assert.rejects(h.features.copyToHost(h.target), /do not let adb read their clipboard/u);
  assert.deepEqual(h.host.written, []);
  assert.deepEqual(h.commands, []);
});

test("a target naming the wrong platform is refused before anything runs", async () => {
  const h = androidHarness();
  await assert.rejects(
    h.features.pasteFromHost({ ...h.target, platform: "ios" }),
    /no longer available/u,
  );
  await assert.rejects(
    h.features.copyToHost({ ...h.target, platform: "ios" }),
    /no longer available/u,
  );
  await assert.rejects(
    h.features.startRecording("chat-1", { ...h.target, platform: "ios" }),
    /no longer available/u,
  );
  assert.equal(h.posts.length + h.children.length, 0);
  assert.deepEqual(h.commands, [], "no simctl or adb ran for a mislabelled emulator");
});

test("an erase mislabelled as iOS never runs simctl on an emulator and leaves its recording alone", async () => {
  const h = androidHarness();
  const recording = await h.features.startRecording("chat-1", h.target);
  await assert.rejects(h.features.erase({ ...h.target, platform: "ios" }), /no longer available/u);
  // The listing says Android, so the renderer's claim is refused before any side effect.
  assert.equal(
    h.features.recordings().find((info) => info.id === recording.id)?.status,
    "recording",
  );
  assert.deepEqual(h.children[0]!.signals, []);
  assert.equal(
    h.commands.some((line) => line.startsWith("xcrun") || line.includes("pkill")),
    false,
  );
  assert.deepEqual(h.events, [], "no shutdown and no refresh");
});

test("erasing an emulator ends its recordings, shuts it down through the hub, and returns its AVD id", async () => {
  const h = androidHarness();
  await h.features.startRecording("chat-1", h.target);
  const phases: string[] = [];
  const result = await h.features.erase(h.target, (phase) => phases.push(phase));
  // The id the listing now has: the AVD name, since the serial is gone with the running emulator.
  assert.deepEqual(result, { wasBooted: true, deviceId: AVD });
  assert.deepEqual(phases, ["shutting-down", "erasing", "erased"]);
  assert.deepEqual(h.features.recordings(), [], "recordings end before anything is erased");
  assert.deepEqual(h.events, [`shutdown:${SERIAL}`, "refresh"]);
  const wipe = h.commands.findIndex((line) =>
    line.startsWith(`emulator -avd ${AVD} -wipe-data -no-snapshot-load`),
  );
  const removed = h.commands.findIndex((line) =>
    line.endsWith(`rm -f ${androidRecordingRemotePath("rec_00000001")}`),
  );
  assert.ok(removed >= 0 && removed < wipe, "the recording's device copy is gone before the wipe");

  // A stopped AVD is erased by its name, without a shutdown.
  const off = androidHarness({ booted: false });
  assert.deepEqual(await off.features.erase(off.target), { wasBooted: false, deviceId: AVD });
  assert.deepEqual(off.events, ["refresh"]);
});

test("a second erase of the same emulator is refused while the first runs", async () => {
  const h = androidHarness({ booted: false });
  const first = h.features.erase(h.target);
  await assert.rejects(h.features.erase(h.target), /already being erased/u);
  await first;
  assert.equal(h.commands.filter((line) => line.startsWith("emulator ")).length, 1);
});

test("Save screenshot writes an emulator's PNG under its AVD name", async () => {
  const h = androidHarness();
  const saved = await h.features.saveScreenshot(
    { hostId: "local", deviceId: SERIAL },
    async (name) => {
      assert.equal(name, "Pixel_9_API_36-2026-10-08-093000.png");
      return "/Users/me/Downloads/emu.png";
    },
  );
  assert.deepEqual(saved, { status: "saved", path: "/Users/me/Downloads/emu.png" });
  assert.deepEqual(h.events, [`screenshot:${SERIAL}`]);
  assert.deepEqual(
    [...(h.files.get("/Users/me/Downloads/emu.png") as Uint8Array)],
    [0x89, 0x50, 0x4e, 0x47],
  );
});
