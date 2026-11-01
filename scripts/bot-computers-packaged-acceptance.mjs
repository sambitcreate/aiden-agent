/* global Buffer, console, process, setTimeout */
// Packaged Bot computers acceptance: owner Mac only (Apple silicon), never in CI.
//
//   AIDEN_BOT_COMPUTERS_ACCEPTANCE=1 npm run test:bot-computers:packaged -- \
//     [--app "release/development/mac-arm64/Aiden Agent.app"] [--restore-image <UniversalMac_…_Restore.ipsw>]
//
// It launches the packaged app with a fresh userData whose only provider is a
// loopback OpenAI-compatible model (capability URL, 127.0.0.1 only) scripting
// the Bot's `computer` and `computer_shell` calls, then walks the operator
// through the real flow: Set up (the base), Give a computer (a clone), the
// Bot's turn (run, capture, click), Take over and Give back in the Computer
// tab, a fresh capture and a shell command whose file must reach the Bot's
// Computer folder, Pause (the VM stops), Delete Bot (its VM goes, the base
// stays), Remove everything, and a normal quit. It reads what happened from
// Lume (the app's own pinned binary, isolated exactly as Aiden runs it), from
// Aiden's state files and from the process table, and writes an evidence-only
// receipt to build/bot-computers-acceptance-receipt.json.
//
// Without --restore-image, Set up downloads macOS (about 20 GB) from Apple's
// pinned URL. With it, the given file is copied (cloned on APFS) to where Set
// up looks first; Set up still verifies its size and SHA-256.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BOT_COMPUTER_GIVE_BACK_NOTE } from "../main/services/bot-computers/control.ts";
import { LUME_PINS, resolveLumeInstallation } from "../main/services/bot-computers/lume-binary.ts";
import { lumeEnvironment, runLume } from "../main/services/bot-computers/lume-cli.ts";
import { parseLumeVmList } from "../main/services/bot-computers/lume-output.ts";
import { BOT_COMPUTER_RESTORE_IMAGE } from "../main/services/bot-computers/release.ts";
import { parseBotComputersState } from "../main/services/bot-computers/store.ts";
import { BOT_COMPUTER_BASE_VM } from "../main/services/bot-computers/vm-names.ts";
import { BOT_PAUSES_FILE } from "../main/services/bot-pause-store.ts";
import {
  ACCEPTANCE_PROMPT,
  ACCEPTANCE_PROVIDER_LABEL,
  acceptanceChatCompletionPath,
  acceptanceFixture,
  acceptanceResponse,
  acceptanceSharedFileName,
  evaluateAcceptanceRequests,
  evaluateComputerTimeline,
  pausedBy,
} from "./bot-computers-packaged-acceptance-core.mjs";
import {
  invalidateBotComputersAcceptanceReceipt,
  resolveBotComputersAcceptanceReceipt,
  writeBotComputersAcceptanceReceipt,
} from "./prepare-macos-package-output.mjs";
import { discoverPackagedApp, packagedArtifactIdentity, verifyMacPackage } from "./verify-macos-package.mjs";

const executeFile = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
/** Set up can download about 20 GB and install macOS, so the whole run gets four hours. */
const ACCEPTANCE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const STEP_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_MS = 2_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readJsonRequest(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Acceptance model request exceeded 64 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** The loopback model. `onTurn` observes the computer at the points the evaluation needs. */
async function startAcceptanceModel({ capability, context, onTurn }) {
  const requests = [];
  const observationErrors = [];
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== acceptanceChatCompletionPath(capability)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readJsonRequest(request);
      requests.push(body);
      const answer = acceptanceResponse(body, context);
      if (answer.kind !== "other") {
        await onTurn(answer).catch((error) => observationErrors.push(error instanceof Error ? error.message : String(error)));
      }
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/event-stream" });
      for (const chunk of answer.chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
      if (answer.kind === "done") finish();
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The loopback model did not bind TCP.");
  return {
    port: address.port,
    requests,
    observationErrors,
    finished,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function processTable() {
  const { stdout } = await executeFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

function startedFrom(command, executable) {
  return command === executable || command.startsWith(`${executable} `);
}

/** What Aiden's state, its pause file and Lume (as Aiden runs it) say now. */
async function observe(paths, lume) {
  const state = parseBotComputersState(await readJson(paths.stateFile));
  let vms = [];
  if (existsSync(paths.storage)) {
    const listed = await runLume(lume.invocation, { op: "list" }, { storage: paths.storage, env: lume.env, timeoutMs: 60_000 });
    if (listed.exitCode !== 0) throw new Error(`lume ls failed: ${listed.stderr.trim()}`);
    vms = parseLumeVmList(listed.stdout).map(({ name, state: vmState }) => ({ name, state: vmState }));
  }
  const processes = (await processTable()).filter((entry) => startedFrom(entry.command, lume.binaryPath));
  return {
    baseBuild: state.setup.baseBuild,
    baseVersion: state.setup.baseVersion,
    computers: Object.entries(state.computers).map(([botId, record]) => ({ botId, vmName: record.vmName })),
    vms,
    processes,
    pauses: await readJson(paths.pausesFile).catch(() => undefined),
  };
}

async function waitUntil(read, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await sleep(POLL_MS);
    last = await read();
  }
  return last;
}

/** The Bot's Computer folder lives in its home under `bot-service`; find the shared file there. */
async function findSharedFile(directory, fileName, depth = 6) {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName && path.basename(directory) === "Computer") return readFile(child, "utf8");
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = await findSharedFile(child, fileName, depth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function preseedRestoreImage(source, imagesDir) {
  const info = await stat(source);
  if (!info.isFile() || info.size !== BOT_COMPUTER_RESTORE_IMAGE.bytes) {
    throw new Error(`--restore-image must be macOS ${BOT_COMPUTER_RESTORE_IMAGE.version} (${BOT_COMPUTER_RESTORE_IMAGE.build}), ${BOT_COMPUTER_RESTORE_IMAGE.bytes} bytes.`);
  }
  await mkdir(imagesDir, { recursive: true, mode: 0o700 });
  const destination = path.join(imagesDir, `UniversalMac_${BOT_COMPUTER_RESTORE_IMAGE.build}_Restore.ipsw`);
  // An APFS clone is instant; fall back to a full copy across volumes.
  await executeFile("/bin/cp", ["-c", source, destination]).catch(() => copyFile(source, destination));
}

function monitorChild(child) {
  let outcome = null;
  const promise = new Promise((resolve) => {
    child.once("error", (error) => {
      outcome = { error };
      resolve(outcome);
    });
    child.once("exit", (code, signal) => {
      if (outcome) return;
      outcome = { code, signal };
      resolve(outcome);
    });
  });
  return { promise, outcome: () => outcome };
}

function beforeDeadline(promise, deadline, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, deadline - Date.now()));
    Promise.resolve(promise).then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** After a failure: quit Aiden if it still runs, and stop any VM it left running. */
async function emergencyCleanup({ child, paths, lume, model }) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (lume && paths && existsSync(paths.storage)) {
    const listed = await runLume(lume.invocation, { op: "list" }, { storage: paths.storage, env: lume.env, timeoutMs: 60_000 }).catch(() => null);
    const running = listed?.exitCode === 0 ? parseLumeVmList(listed.stdout).filter((vm) => vm.state !== "stopped") : [];
    for (const vm of running) {
      await runLume(lume.invocation, { op: "stop", name: vm.name, force: true }, { storage: paths.storage, env: lume.env, timeoutMs: 120_000 }).catch(() => undefined);
    }
  }
  await model?.close().catch(() => undefined);
}

async function runAcceptance() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Packaged Bot computers acceptance needs a Mac with Apple silicon.");
  }
  if (process.env.AIDEN_BOT_COMPUTERS_ACCEPTANCE !== "1") {
    throw new Error(
      "This test creates macOS virtual machines and, without --restore-image, downloads about 20 GB from Apple. " +
        "Re-run with AIDEN_BOT_COMPUTERS_ACCEPTANCE=1 after reading the checklist at the top of this script.",
    );
  }
  await invalidateBotComputersAcceptanceReceipt(repositoryRoot);
  const receiptPath = resolveBotComputersAcceptanceReceipt(repositoryRoot);
  const appPath = path.resolve(argumentValue("--app") ?? (await discoverPackagedApp(path.join(repositoryRoot, "release", "development"))));
  const restoreImage = argumentValue("--restore-image");
  await verifyMacPackage(appPath);
  const artifact = await packagedArtifactIdentity(appPath);
  const executable = path.join(appPath, "Contents", "MacOS", "Aiden Agent");
  if ((await processTable()).some((entry) => startedFrom(entry.command, executable))) {
    throw new Error("Quit every running Aiden window before starting the isolated acceptance run.");
  }

  // Lume exactly as the packaged Aiden runs it: its own pinned, verified binary, an isolated home, Aiden's storage.
  const installation = await resolveLumeInstallation({
    platform: process.platform,
    arch: process.arch,
    isPackaged: true,
    resourcesPath: path.join(appPath, "Contents", "Resources"),
    appPath,
  });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-bot-computers-acceptance-"));
  const userData = path.join(temporary, "user-data");
  const root = path.join(userData, "bot-computers");
  const paths = {
    storage: path.join(root, "vms"),
    stateFile: path.join(root, "state.json"),
    pausesFile: path.join(userData, "bot-service", BOT_PAUSES_FILE),
    botService: path.join(userData, "bot-service"),
  };
  const lume = {
    invocation: installation.invocation,
    binaryPath: installation.binaryPath,
    env: lumeEnvironment(process.env, path.join(root, "home")),
  };
  const nonce = randomBytes(16).toString("hex");
  const capability = randomBytes(32).toString("base64url");
  const context = { giveBackNote: BOT_COMPUTER_GIVE_BACK_NOTE, nonce };
  const timeline = {};
  let botId;
  let sharedFileText;
  let model = null;
  let child = null;
  let completed = false;
  let failure = null;

  const onTurn = async ({ history, call }) => {
    if (history.length === 0 && !timeline.given) {
      const now = await observe(paths, lume);
      timeline.given = now;
      botId = now.computers[0]?.botId;
      console.log("The Bot's turn started; its first capture boots its computer (this can take a few minutes).");
    }
    if (history[0]?.result && !timeline.working) timeline.working = await observe(paths, lume);
    if (call?.arguments?.action === "wait" && !history.some((entry) => entry.args?.action === "wait")) {
      console.log("\n>>> NOW: open the Bot's Computer tab, press Take over, use the computer for a moment, then press Give back.\n");
    }
    if (history.some((entry) => entry.name === "computer_shell" && entry.result) && sharedFileText === undefined) {
      sharedFileText = (await findSharedFile(paths.botService, acceptanceSharedFileName(nonce))) ?? null;
    }
  };

  try {
    if (restoreImage) await preseedRestoreImage(path.resolve(restoreImage), path.join(root, "restore-images"));
    model = await startAcceptanceModel({ capability, context, onTurn });
    const fixture = acceptanceFixture(model.port, capability);
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, "config.json"), JSON.stringify(fixture.config, null, 2), "utf8");

    const log = path.join(temporary, "aiden.log");
    child = spawn(executable, [`--user-data-dir=${userData}`], { env: { ...process.env, AIDEN_ANALYTICS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    if (!child.pid) throw new Error("The packaged Aiden process did not start.");
    const childState = monitorChild(child);
    const logStream = createWriteStream(log, { flags: "a", mode: 0o600 });
    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    child.once("exit", () => logStream.end());
    const deadline = Date.now() + ACCEPTANCE_TIMEOUT_MS;

    console.log(`\nPackaged Bot computers acceptance is running in ${temporary} (Aiden's log: ${log}).`);
    console.log("1. If onboarding opens, check that its feature tour shows Bot computers, then finish onboarding.");
    console.log(`2. Settings → Bot computers → Set up${restoreImage ? " (the restore image is pre-seeded; Set up verifies it)" : " (downloads about 20 GB)"}. Wait for Ready.`);
    console.log(`3. Create a Bot with Full access whose AI model is ${ACCEPTANCE_PROVIDER_LABEL}.`);
    console.log("4. In the Bot's profile, give the Bot a computer.");
    console.log(`5. In the Bot's chat, send exactly: ${ACCEPTANCE_PROMPT}`);
    console.log("6. When this terminal says NOW, Take over in the Computer tab, then Give back (not before: a Take over that interrupts the click fails the run).");
    console.log("Then follow this terminal: Pause the Bot, Delete the Bot, Remove everything, and quit Aiden.");
    console.log("No model data leaves this Mac; the model listens only on 127.0.0.1.\n");

    await beforeDeadline(
      Promise.race([model.finished, childState.promise.then(() => Promise.reject(new Error("Aiden quit before the Bot's sequence ended.")))]),
      deadline,
      "The Bot's acceptance sequence did not end within four hours.",
    );
    if (!botId) throw new Error("No Bot had been given a computer when the prompt arrived.");
    const vmName = timeline.given.computers[0].vmName;
    const vmProcesses = (now) => now.processes.filter((entry) => entry.command.includes(vmName)).length;
    const stateOf = (now, name) => now.vms.find((vm) => vm.name === name)?.state;

    console.log("7. The Bot's sequence ended. Pause the Bot now (its profile or chat header → Pause).");
    const paused = await waitUntil(
      () => observe(paths, lume),
      (now) => pausedBy(now.pauses, botId) === "mac" && stateOf(now, vmName) === "stopped" && vmProcesses(now) === 0,
      STEP_TIMEOUT_MS,
    );
    timeline.paused = { pausedBy: pausedBy(paused.pauses, botId), vms: paused.vms, vmProcesses: vmProcesses(paused) };

    console.log("8. Paused and stopped. Now delete the Bot (its profile → Delete Bot).");
    timeline.deleted = await waitUntil(
      () => observe(paths, lume),
      (now) => now.computers.length === 0 && stateOf(now, vmName) === undefined,
      STEP_TIMEOUT_MS,
    );

    console.log("9. Deleted. Now choose Settings → Bot computers → Remove everything.");
    timeline.removed = await waitUntil(
      () => observe(paths, lume),
      (now) => now.vms.length === 0 && !now.baseBuild,
      STEP_TIMEOUT_MS,
    );

    console.log("10. Removed. Quit Aiden normally (Aiden Agent → Quit).");
    const exit = await beforeDeadline(childState.promise, deadline, "Aiden was not quit before the acceptance deadline.");
    if (exit.error) throw exit.error;
    if (exit.code !== 0 || exit.signal !== null) throw new Error(`Packaged Aiden did not exit normally (${exit.code ?? exit.signal}).`);
    child = null;
    await sleep(3_000);
    timeline.afterQuit = {
      lumeProcesses: (await processTable()).filter((entry) => startedFrom(entry.command, lume.binaryPath)).length,
    };

    const requests = evaluateAcceptanceRequests(model.requests, { ...context, sharedFileText: sharedFileText ?? undefined });
    const computer = evaluateComputerTimeline(timeline, { baseVm: BOT_COMPUTER_BASE_VM });
    const failures = [...model.observationErrors, ...requests.failures, ...computer.failures];
    if (failures.length > 0) throw new Error(failures.join("\n"));
    await model.close();
    model = null;

    await writeBotComputersAcceptanceReceipt(
      JSON.stringify(
        {
          schemaVersion: 1,
          completedAt: new Date().toISOString(),
          artifact,
          modelTransport: "capability_authenticated_loopback",
          lume: LUME_PINS.version,
          base: { version: timeline.given.baseVersion ?? null, build: timeline.given.baseBuild },
          guestMacos: requests.evidence.macosVersion,
          restoreImage: restoreImage ? "preseeded_and_verified_by_set_up" : "downloaded_by_set_up",
          capture: requests.evidence.captureSize,
          interruptedAction: requests.evidence.interrupted,
          checks: [
            "set_up_built_base",
            "give_cloned_a_stopped_vm",
            "capture_started_the_vm",
            "capture_jpeg_within_1280",
            "click_landed",
            "take_over_interrupted_the_call",
            "give_back_returned_the_note",
            "fresh_capture_after_give_back",
            "computer_shell_ran_in_the_guest",
            "shared_folder_reached_the_computer_folder",
            "pause_stopped_the_vm",
            "delete_bot_removed_the_vm_and_kept_the_base",
            "remove_everything_left_nothing",
            "normal_app_quit",
            "no_lume_process_after_quit",
          ],
        },
        null,
        2,
      ),
      repositoryRoot,
    );
    await rm(temporary, { recursive: true, force: true });
    completed = true;
    console.log(`Packaged Bot computers acceptance passed. Receipt: ${receiptPath}`);
  } catch (error) {
    failure = error;
  } finally {
    if (!completed) {
      await invalidateBotComputersAcceptanceReceipt(repositoryRoot).catch(() => undefined);
      await emergencyCleanup({ child, paths, lume, model });
      console.error(`Acceptance evidence was kept for diagnosis at ${temporary}. It can hold VM disks; delete it when done.`);
    }
  }
  if (failure) throw failure;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) await runAcceptance();
