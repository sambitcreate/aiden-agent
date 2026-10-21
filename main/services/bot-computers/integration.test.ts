// A Bot's computer end to end (plan §8), with only the edges faked:
//
// - the real host drives the fake Lume CLI (`tests/e2e/lume-fake.mjs`), which
//   plays each VM as a detached process whose VNC listener forwards to a fake
//   RFB server; that server checks each run's `--vnc-password`, so the screen
//   the Bot captures and clicks is the test's;
// - the real control, activity, sessions and RFB screen (with an encoder
//   standing in for Electron's nativeImage), the real viewer and the real IPC
//   handlers, composed the way `bot-computers-main.ts` composes them;
// - the Bot's real `computer` tool in a real Bot session with the real tool
//   assembly and rules, and a scripted model;
// - the Computer tab's real device stream client.
//
// The model's view of each tool result is the oracle for what the Bot was
// told; the fake RFB server's record is the oracle for what reached the guest.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createDeviceStreamClient, type DeviceStreamRuntime } from "../../../renderer/lib/device-stream.js";
import {
  BOT_COMPUTER_CHANNELS,
  type BotComputerPointer,
  type BotComputerStatus,
  type BotComputerViewerGrant,
} from "../../../renderer/shared/bot-computers.js";
import { defaultBotRules } from "../../../renderer/shared/bot-rules.js";
import { registerBotComputerHandlers } from "../../handlers/bot-computers.js";
import { createBotPauseStore } from "../bot-pause-store.js";
import { botComputerAction } from "../bot-runtime/bot-computer-approval.js";
import { createBotSessionService, type BotSessionRuntime } from "../bot-runtime/bot-session-service.js";
import { assemblyDeps, assemblyState, FULL_GRANTS, testAuthority } from "../bot-runtime/test-support/assembly-fixtures.js";
import { createFauxModels, FAUX_MODEL_REF, waitFor, type FauxModels } from "../bot-runtime/test-support/faux.js";
import type { BoundedProcessOptions, BoundedProcessResult } from "./bounded-process.js";
import { BOT_COMPUTER_GIVE_BACK_NOTE, createBotComputerControl } from "./control.js";
import { BOT_COMPUTER_WAIT_MAX_SECONDS } from "./computer-schema.js";
import { createBotComputerTool, createBotComputerToolState } from "./computer-tool.js";
import { createBotComputerHost } from "./host.js";
import { FakeRfbServer } from "./rfb-fake-server.js";
import { createRfbScreenFactory } from "./rfb-screen-main.js";
import type { BotComputerImageEncoder } from "./rfb-screen.js";
import { createBotComputerActivity, createBotComputerSessions } from "./sessions.js";
import { createBotComputerViewer } from "./viewer-main.js";
import { BOT_COMPUTER_BASE_VM, botComputerVmName } from "./vm-names.js";

/** The assembly fixtures' authority belongs to this Bot. */
const BOT = "bot-1";
const VM = botComputerVmName(BOT);
const LUME_FAKE = path.resolve("tests/e2e/lume-fake.mjs");
/** The guest's screen; the Bot's captures are bounded to 1280 px wide, so they come back at 1280×800. */
const SCREEN = { width: 1440, height: 900 } as const;
const WALLPAPER = [30, 144, 255] as const;
const NOTES = "Agenda: ship the Q3 plan, then review hiring. ".repeat(14);
const RESTORE_IMAGE = Buffer.from("fake macOS restore image for the integration test\n".repeat(64));

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const never = () => new AbortController().signal;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a process still runs. An exited fake VM nobody reaped (a zombie) has stopped. */
function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") !== true;
  } catch {
    return true;
  }
}

/**
 * Stands in for Electron's nativeImage: it scales the way the production
 * encoder does and says what the frame shows at its centre, so a test can
 * tell the guest's real pixels reached the Bot.
 */
const fakeEncoder: BotComputerImageEncoder = async (bgra, width, height, format, quality, maxWidth) => {
  const scale = Math.min(1, maxWidth / width);
  const size = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  const centre = `rgb(${bgra[at + 2]},${bgra[at + 1]},${bgra[at]})`;
  return { image: Buffer.from(`${format} q${quality} ${size.width}x${size.height} centre ${centre}`), ...size };
};

interface ModelView {
  toolName: string;
  isError: boolean;
  text: string;
  images: { mimeType: string; data: string }[];
}

/** The newest tool result in what the model was sent. */
function lastToolResult(messages: readonly Message[]): ModelView {
  const result = [...messages].reverse().find((message) => message.role === "toolResult");
  if (!result || result.role !== "toolResult") throw new Error("The model was sent no tool result.");
  return {
    toolName: result.toolName,
    isError: result.isError,
    text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    images: result.content.flatMap((part) => (part.type === "image" ? [{ mimeType: part.mimeType, data: part.data }] : [])),
  };
}

const callComputer = (id: string, args: Parameters<typeof fauxToolCall>[1]): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall("computer", args, { id })], { stopReason: "toolUse" });

interface FakeVm {
  status: string;
  pid?: number;
  vncPassword?: string;
}

interface LumeCall {
  kind: string;
  op?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}

/** Everything a person, a Bot and main share, built the way main builds it. */
async function world(model: { steps: Parameters<typeof createFauxModels>[0] }) {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-bot-computer-integration-"));
  roots.push(dir);
  const root = path.join(dir, "bot-computers");
  const profile = path.join(dir, "profile");
  const botHome = path.join(dir, "bots", BOT, "home");
  mkdirSync(botHome, { recursive: true });
  const computerDir = path.join(dir, "bots", BOT, "Computer");

  const fakeState = (): { vms: Record<string, FakeVm> } => {
    try {
      return JSON.parse(readFileSync(path.join(root, "vms", ".fake-state.json"), "utf8")) as { vms: Record<string, FakeVm> };
    } catch {
      return { vms: {} };
    }
  };
  // The guest's screen. Each connection must answer the password of the run it reached.
  const rfb = new FakeRfbServer({ ...SCREEN, password: () => fakeState().vms[VM]?.vncPassword ?? "no run yet" });
  rfb.paint({ x: 0, y: 0, ...SCREEN }, WALLPAPER);
  const rfbPort = await rfb.listen();

  const lumeLog = path.join(dir, "lume-calls.jsonl");
  const configFile = path.join(dir, "fake-lume.json");
  writeFileSync(configFile, JSON.stringify({ log: lumeLog, vncUpstream: rfbPort }));
  const lumeCalls = (): LumeCall[] =>
    existsSync(lumeLog)
      ? readFileSync(lumeLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LumeCall)
      : [];

  // System ssh and ssh-keygen: the guest accepts Aiden's key and every provisioning step.
  const runProcess = async (command: string, args: readonly string[], _options: BoundedProcessOptions): Promise<BoundedProcessResult> => {
    if (command.endsWith("ssh-keygen")) {
      const file = args[args.indexOf("-f") + 1] ?? "";
      writeFileSync(file, "PRIVATE", { mode: 0o600 });
      writeFileSync(`${file}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAidenKeyForBotComputerIntegrationTests0123456 aiden\n");
    }
    return { exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, timedOut: false };
  };

  const secrets = new Map<string, string>();
  const control = createBotComputerControl();
  const activity = createBotComputerActivity();
  const botName = () => "Ada";
  const host = createBotComputerHost({
    root,
    lume: async () => ({ command: process.execPath, prefixArgs: [LUME_FAKE, "--fake-config", configFile] }),
    support: () => ({ ok: true }),
    botComputerDir: async () => computerDir,
    botName,
    secrets: {
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => void secrets.set(name, value),
      deleteFamily: async (prefix) => {
        for (const key of [...secrets.keys()]) if (key.startsWith(prefix)) secrets.delete(key);
      },
    },
    env: { LANG: "en_US.UTF-8" },
    resources: { freeDiskBytes: async () => 1e13, availableMemoryBytes: async () => 64 * 1024 ** 3 },
    fetchImpl: (async () => new Response(new Uint8Array(RESTORE_IMAGE))) as typeof fetch,
    image: {
      version: "26.6.2",
      build: "25G83",
      url: "https://updates.cdn-apple.com/test/UniversalMac_26.6.2_25G83_Restore.ipsw",
      bytes: RESTORE_IMAGE.length,
      sha256: createHash("sha256").update(RESTORE_IMAGE).digest("hex"),
    },
    // Idle stop is not part of this story.
    schedule: () => () => undefined,
    pollIntervalMs: 20,
    runProcess,
    control,
    activity,
  });
  // As `botComputers()` in bot-computers-main.ts: one control and activity for all, and the RFB screen per run.
  const sessions = createBotComputerSessions({ host, control, activity, botName });
  sessions.setScreenFactory(createRfbScreenFactory({ encode: fakeEncoder }));
  const viewer = createBotComputerViewer({ host, sessions, control, botName, allowedOrigins: ["file://"] });

  // The renderer's side: the IPC handlers Settings, the Bot profile and the Computer tab call.
  const bots = new Set([BOT]);
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotComputerHandlers({
    handle: (channel, handler) => void handlers.set(channel, handler),
    host,
    viewer,
    control,
    sessions,
    broadcast: () => undefined,
    botExists: async (botId) => bots.has(botId),
  });
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}.`);
    return (await handler({}, ...args)) as T;
  };

  // The Bot: its computer tool as production offers it (`bot-tool-sources-main.ts`), through the real assembly.
  const toolState = createBotComputerToolState(control);
  const computerTool = createBotComputerTool(
    BOT,
    { host, sessions, control, state: toolState, botName: async () => "Ada" },
    { routine: false, unattended: false },
  );
  const assembly = assemblyState(
    testAuthority({ mode: "full", home: botHome, ...FULL_GRANTS, other: [...FULL_GRANTS.other, "computer"] }),
  );
  const extension = assemblyDeps(assembly, {
    candidates: () => (assembly.hasComputer ? [{ tool: computerTool, replay: "unsafe" }] : []),
    approvalFor: async (toolName, call) => (toolName === "computer" ? botComputerAction(call) : undefined),
    rules: () => defaultBotRules(),
    botName: "Ada",
  });
  const fauxModels: FauxModels = createFauxModels(model.steps);
  const service: BotSessionRuntime = await createBotSessionService({
    profileDir: profile,
    models: fauxModels.models,
    extension,
    resolveModel: async () => FAUX_MODEL_REF,
    knownBotIds: async () => new Set(bots),
    pauses: createBotPauseStore({ root: () => path.join(profile, "bot-service"), now: () => 1_000 }),
    // The stop `afterBotPaused` starts in the background (bot-session-main.ts), awaited here so the VM can be checked as the pause answers.
    afterPaused: (botId) => host.stop(botId, { reason: "pause" }),
    // As the `deleteEffects` in bot-session-main.ts: the computer goes before the Bot's data.
    deleteEffects: [(botId) => host.deleteForBot(botId), async (botId) => void bots.delete(botId)],
  }).catch(async (error: unknown) => {
    await Promise.allSettled([viewer.close(), host.shutdown(5_000), rfb.close()]);
    throw error;
  });

  const cleanups: (() => unknown)[] = [];
  return {
    dir,
    root,
    computerDir,
    rfb,
    host,
    control,
    viewer,
    service,
    fauxModels,
    assembly,
    invoke,
    fakeState,
    lumeCalls,
    runsOf: (vmName: string) => lumeCalls().filter((call) => call.kind === "cli" && call.op === "run" && call.args?.[1] === vmName),
    onCleanup: (cleanup: () => unknown) => void cleanups.push(cleanup),
    async cleanup() {
      for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
      await service.shutdown().catch(() => undefined);
      await viewer.close().catch(() => undefined);
      await host.shutdown(5_000).catch(() => undefined);
      await rfb.close();
      const pids = new Set([...Object.values(fakeState().vms).map((vm) => vm.pid), ...lumeCalls().map((call) => (call as { pid?: number }).pid)]);
      for (const pid of pids) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** The Computer tab: the renderer's device stream client on the grant the viewer lends. */
function openComputerTab(lent: BotComputerViewerGrant) {
  const inputs: boolean[] = [];
  let mjpegUrl: string | undefined;
  const runtime: DeviceStreamRuntime = {
    fetch: (url, init) => fetch(url, init),
    createSocket: (url) => new WebSocket(url) as unknown as ReturnType<DeviceStreamRuntime["createSocket"]>,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const client = createDeviceStreamClient(
    { hostId: lent.hostId, deviceId: lent.deviceId, grant: lent.grant, platform: "ios", preferMjpeg: true },
    { present: () => true },
    {
      onStatus: () => undefined,
      onScreen: () => undefined,
      onUnauthorized: () => undefined,
      onMjpegFallback: (url) => {
        mjpegUrl = url;
      },
      onInputConnected: (connected) => inputs.push(connected),
    },
    runtime,
  );
  client.start();
  return {
    client,
    inputs,
    mjpegUrl: () => mjpegUrl,
    /** The first frame the tab's <img> would show. */
    async firstFrame(): Promise<string> {
      const response = await fetch(mjpegUrl!);
      const reader = response.body!.getReader();
      let text = "";
      while (!/centre rgb\(\d+,\d+,\d+\)/u.test(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += Buffer.from(chunk.value).toString();
      }
      await reader.cancel();
      return text;
    },
  };
}

/** Every Lume call named Aiden's storage, with telemetry and update checks off and HOME isolated. */
function assertLumeIsolated(context: World): void {
  const storage = path.join(context.root, "vms");
  for (const call of context.lumeCalls().filter((entry) => entry.kind === "cli")) {
    const args = call.args ?? [];
    assert.equal(call.env?.LUME_TELEMETRY_ENABLED, "false", `${call.op} ran with telemetry off`);
    assert.equal(call.env?.LUME_UPDATE_CHECK, "false");
    assert.equal(call.env?.HOME, path.join(context.root, "home"));
    if (call.op === "clone") {
      assert.equal(args[args.indexOf("--source-storage") + 1], storage);
      assert.equal(args[args.indexOf("--dest-storage") + 1], storage);
    } else {
      assert.equal(args[args.indexOf("--storage") + 1], storage, `${call.op} names Aiden's storage`);
    }
  }
}

test(
  "a Bot's computer from Give to Delete: a capture boots it, a click lands, Take over and Give back, Pause stops it, deleting the Bot removes it",
  { timeout: 120_000 },
  async () => {
    const seen: { capture?: ModelView; click?: ModelView; typed?: ModelView } = {};
    const context = await world({
      steps: [
        // "Click OK on your computer."
        callComputer("look", { action: "capture" }),
        ({ messages }: { messages: readonly Message[] }) => {
          seen.capture = lastToolResult(messages);
          return callComputer("ok", { action: "click", coordinate: [640, 400], intent: "Click OK" });
        },
        ({ messages }: { messages: readonly Message[] }) => {
          seen.click = lastToolResult(messages);
          return fauxAssistantMessage("Clicked OK.");
        },
        // "Type the meeting notes."
        callComputer("notes", { action: "type", text: NOTES, intent: "Type the meeting notes" }),
        ({ messages }: { messages: readonly Message[] }) => {
          seen.typed = lastToolResult(messages);
          return fauxAssistantMessage("I'll take a fresh capture before I go on.");
        },
        // "Wait for the download."
        callComputer("wait", { action: "wait", seconds: BOT_COMPUTER_WAIT_MAX_SECONDS }),
        fauxAssistantMessage("never sent: the Bot is paused first"),
      ],
    });
    try {
      // Settings → Bot computers → Set up, then the Bot profile's Give Ada a computer.
      await context.host.setUp();
      assert.equal((await context.host.status()).setup.kind, "ready");
      const given = await context.invoke<BotComputerStatus>(BOT_COMPUTER_CHANNELS.give, BOT);
      assert.equal(given.vmName, VM);
      assert.equal(given.state, "stopped");
      assert.ok(context.fakeState().vms[VM], "the computer is a clone in Aiden's storage");
      assert.deepEqual(context.runsOf(VM), [], "giving a computer starts nothing");
      context.assembly.hasComputer = true;

      // 1. A capture boots the computer; the Bot sees the guest's screen, then its click lands.
      const first = await context.service.send(BOT, { text: "Click OK on your computer.", requestId: "desk-1" });
      assert.deepEqual(await context.service.awaitReply(BOT, first.submissionId, never()), { kind: "completed", text: "Clicked OK." });
      const [run] = context.runsOf(VM);
      assert.ok(run, "the capture started the computer");
      assert.equal(context.runsOf(VM).length, 1);
      const runArgs = run.args ?? [];
      assert.equal(runArgs[runArgs.indexOf("--shared-dir") + 1], `${context.computerDir}:rw`, "its Computer folder is shared read-write");
      const password = runArgs[runArgs.indexOf("--vnc-password") + 1];
      assert.ok(password && password.length >= 16, "each run gets its own VNC password");
      const [connection] = context.rfb.connections;
      assert.equal(context.rfb.connections.length, 1);
      assert.equal(connection!.authenticated, true, "the screen signed in with the run's password");

      assert.equal(seen.capture?.toolName, "computer");
      assert.equal(seen.capture?.isError, false);
      assert.match(seen.capture!.text, /^Screenshot of Ada's computer, 1280×800 pixels\./u);
      assert.equal(seen.capture?.images.length, 1);
      assert.equal(seen.capture!.images[0]!.mimeType, "image/jpeg");
      assert.equal(
        Buffer.from(seen.capture!.images[0]!.data, "base64").toString(),
        `jpeg q70 1280x800 centre rgb(${WALLPAPER.join(",")})`,
        "a JPEG at most 1280 px wide, quality 70, of the guest's own screen",
      );
      assert.equal(JSON.stringify(seen).includes(password), false, "the model never sees the VNC password");

      // Capture pixels (640, 400) are framebuffer pixels (720, 450). The guest reads the last event a moment after it was sent.
      await waitFor(() => connection!.pointer.length >= 3, { what: "the click to reach the guest" });
      assert.deepEqual(connection!.pointer, [
        { x: 720, y: 450, buttons: 0 },
        { x: 720, y: 450, buttons: 1 },
        { x: 720, y: 450, buttons: 0 },
      ]);
      assert.equal(seen.click?.isError, false);
      assert.equal(seen.click?.text, "Clicked at (640, 400).");
      // The Computer tab draws the Bot's avatar where it clicked, and the status line says what it did.
      assert.deepEqual(await context.invoke<BotComputerPointer | null>(BOT_COMPUTER_CHANNELS.pointer, BOT), {
        x: 720,
        y: 450,
        width: SCREEN.width,
        height: SCREEN.height,
      });
      const working = await context.host.computer(BOT);
      assert.equal(working?.state, "running");
      assert.equal(working?.activity, "Ada is using the computer: Click OK");

      // 2. The person opens the Computer tab on the running computer: it shows the same screen, over the same connection.
      const lent = await context.invoke<BotComputerViewerGrant>(BOT_COMPUTER_CHANNELS.viewerGrant, BOT, { start: false });
      const tab = openComputerTab(lent);
      context.onCleanup(() => tab.client.stop());
      await waitFor(() => tab.inputs.includes(true) && tab.mjpegUrl() !== undefined, { what: "the Computer tab to connect" });
      assert.match(await tab.firstFrame(), new RegExp(`centre rgb\\(${WALLPAPER.join(",")}\\)`, "u"));
      assert.equal(context.rfb.connections.length, 1, "the person watches through the Bot's own VNC connection");

      // 3. While the Bot types, the person presses Take over: the typing stops mid-way and nothing stays held.
      const second = await context.service.send(BOT, { text: "Type the meeting notes.", requestId: "desk-2" });
      await waitFor(() => connection!.keys.length >= 20, { what: "the Bot to start typing" });
      const modelCalls = context.fauxModels.calls();
      const taken = await context.invoke<BotComputerStatus>(BOT_COMPUTER_CHANNELS.takeOver, BOT);
      assert.equal(taken.controller, "person");
      let keyCount = -1;
      await waitFor(
        async () => {
          const settled = connection!.keys.length === keyCount;
          keyCount = connection!.keys.length;
          await sleep(50);
          return settled;
        },
        { what: "the Bot's keys to stop" },
      );
      const botKeys = [...connection!.keys];
      const typedCharacters = botKeys.filter((key) => key.down && key.keysym < 0xff00).length;
      assert.ok(typedCharacters > 0 && typedCharacters < NOTES.length, `Take over stopped the typing (${typedCharacters} typed)`);
      const held = new Map<number, number>();
      for (const key of botKeys) held.set(key.keysym, (held.get(key.keysym) ?? 0) + (key.down ? 1 : -1));
      assert.deepEqual([...held.values()].filter((count) => count !== 0), [], "every key the Bot pressed was released");
      // The Bot's turn waits for the person; the model hears nothing yet.
      await sleep(200);
      assert.equal(context.fauxModels.calls(), modelCalls);
      assert.equal((await context.service.state(BOT)).kind, "running");
      assert.equal((await context.host.computer(BOT))?.controller, "person");

      // The person's own click in the tab reaches the guest at the framebuffer point they touched.
      tab.client.sendTouch("begin", 0.25, 0.5);
      tab.client.sendTouch("end", 0.25, 0.5);
      await waitFor(() => connection!.pointer.length === 5, { what: "the person's click" });
      assert.deepEqual(connection!.pointer.slice(3), [
        { x: 360, y: 450, buttons: 1 },
        { x: 360, y: 450, buttons: 0 },
      ]);
      assert.equal(connection!.keys.length, botKeys.length, "nothing more was typed while the person had the computer");

      // Give back: the interrupted call returns the note, and the Bot's turn goes on.
      const returned = await context.invoke<BotComputerStatus>(BOT_COMPUTER_CHANNELS.giveBack, BOT);
      assert.equal(returned.controller, "bot");
      assert.deepEqual(await context.service.awaitReply(BOT, second.submissionId, never()), {
        kind: "completed",
        text: "I'll take a fresh capture before I go on.",
      });
      assert.equal(seen.typed?.toolName, "computer");
      assert.equal(seen.typed?.isError, false);
      assert.equal(seen.typed?.text, BOT_COMPUTER_GIVE_BACK_NOTE);
      assert.deepEqual(seen.typed?.images, [], "nothing the person did was captured for the Bot");

      // 4. Pausing the Bot mid-call stops its computer at once.
      const third = await context.service.send(BOT, { text: "Wait for the download.", requestId: "desk-3" });
      await waitFor(() => context.control.activeActions(BOT) === 1, { what: "the Bot's wait to start" });
      const vmPid = context.fakeState().vms[VM]?.pid;
      assert.ok(vmPid && processRunning(vmPid), "the computer is running");
      const paused = await context.service.pause(BOT, "mac");
      assert.deepEqual(paused, { kind: "paused", since: 1_000, by: "mac", interrupted: third.submissionId });
      assert.equal(context.fakeState().vms[VM]?.status, "stopped", "the VM was stopped");
      await waitFor(() => !processRunning(vmPid), { what: "the VM's process to end" });
      await waitFor(() => connection!.socket.destroyed, { what: "the screen connection to close" });
      await waitFor(() => tab.inputs[tab.inputs.length - 1] === false, { what: "the Computer tab's stream to end" });
      const stopped = await context.host.computer(BOT);
      assert.equal(stopped?.state, "stopped");
      assert.equal(stopped?.activity, undefined, "the status line cleared with the run");
      await sleep(200);
      assert.equal(context.fauxModels.calls(), modelCalls + 2, "nothing ran after the pause");
      assert.equal(context.runsOf(VM).length, 1, "nothing started it again");

      // 5. Deleting the Bot deletes its computer and keeps the shared base.
      await context.service.deleteBot(BOT);
      assert.equal(await context.host.computer(BOT), undefined);
      assert.equal(context.fakeState().vms[VM], undefined, "Lume no longer has the Bot's VM");
      assert.equal(existsSync(path.join(context.root, "vms", VM)), false, "its disk is gone");
      assert.ok(context.fakeState().vms[BOT_COMPUTER_BASE_VM], "the base stays for other Bots");
      assert.deepEqual((await context.host.status()).computers, []);
      await assert.rejects(context.viewer.grant(BOT, { start: true }), /Ada's computer has been removed/u);
      assert.equal(context.runsOf(VM).length, 1, "deleting never started it");

      assertLumeIsolated(context);
    } finally {
      await context.cleanup();
    }
  },
);
