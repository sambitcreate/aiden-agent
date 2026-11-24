/* global Buffer, console, process, setTimeout */

import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ACCEPTANCE_DECOY_INITIAL_TEXT,
  ACCEPTANCE_DENIED_MODEL,
  ACCEPTANCE_DENIED_TEXT,
  ACCEPTANCE_MODEL,
  ACCEPTANCE_SAVED_TEXT,
  ACCEPTANCE_TARGET_INITIAL_TEXT,
  ACCEPTANCE_TOOL_COUNT,
  ACCEPTANCE_TWO_WINDOW_TOOL_COUNT,
  acceptanceChatCompletionPath,
  acceptanceDeniedToolCall,
  acceptanceFixture,
  acceptanceGateEvidence,
  acceptanceToolCall,
  buildUnsupportedRealDesktopReport,
  classifyAcceptanceError,
  correlatedToolMessage,
  evaluateAcceptanceRequests,
  evaluateDeniedPermissionCheck,
  evaluateHostSupport,
  evaluateRealDesktopReport,
  evaluateStopCleanupCheck,
  evaluateTextEditMarkerCheck,
  evaluateTwoWindowsIsolationCheck,
  openAiToolCallChunks,
  REAL_DESKTOP_CHECK_IDS,
  renderRealDesktopReport,
  resolveAcceptanceTarget,
  resolveAcceptanceWindows,
} from "./computer-use-packaged-acceptance-core.mjs";
import { CUA_DRIVER_ARTIFACT_PROVENANCE } from "./computer-use-signing-pins.mjs";
import {
  invalidateComputerUseAcceptanceReceipt,
  resolveComputerUseAcceptanceReceipt,
  writeComputerUseAcceptanceReceipt,
} from "./prepare-macos-package-output.mjs";
import {
  discoverPackagedApp,
  packagedArtifactIdentity,
  verifyMacPackage,
} from "./verify-macos-package.mjs";

const executeFile = promisify(execFile);
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(modulePath), "..");
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const ACCEPTANCE_TIMEOUT_MS = 15 * 60 * 1_000;
const PROCESS_POLL_MS = 250;
const TEXTEDIT_BUNDLE_ID = "com.apple.TextEdit";
const TEXTEDIT_KNOWN_PATHS = Object.freeze([
  "/System/Applications/TextEdit.app",
  "/Applications/TextEdit.app",
]);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function readHostMacOSVersion({
  platform = process.platform,
  exec = executeFile,
} = {}) {
  if (platform !== "darwin") return `unavailable (${platform})`;
  try {
    const { stdout } = await exec("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" });
    const version = String(stdout ?? "").trim();
    return version || `unavailable (${os.release()})`;
  } catch {
    return `unavailable (${os.release()})`;
  }
}

export async function readHostCursorPosition({
  platform = process.platform,
  exec = executeFile,
} = {}) {
  if (platform !== "darwin") {
    throw new Error(`Host cursor position probe is macOS-only (host platform is ${platform}).`);
  }
  const { stdout } = await exec(
    "/usr/bin/osascript",
    [
      "-l",
      "JavaScript",
      "-e",
      'ObjC.import("AppKit"); const p = $.NSEvent.mouseLocation; JSON.stringify({ x: p.x, y: p.y });',
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  let parsed;
  try {
    parsed = JSON.parse(String(stdout ?? "").trim());
  } catch {
    throw new Error("Could not parse host mouse cursor position from AppKit.");
  }
  if (
    !parsed ||
    typeof parsed.x !== "number" ||
    !Number.isFinite(parsed.x) ||
    typeof parsed.y !== "number" ||
    !Number.isFinite(parsed.y)
  ) {
    throw new Error("Host mouse cursor position was not a finite coordinate pair.");
  }
  return { x: parsed.x, y: parsed.y };
}

export async function readPackagedMetadata({
  root = repositoryRoot,
  appPath = null,
  artifact = null,
  platform = process.platform,
  exec = executeFile,
} = {}) {
  let appVersion = artifact?.shortVersion ?? null;
  if (!appVersion) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      appVersion = typeof manifest?.version === "string" ? manifest.version : "unknown";
    } catch {
      appVersion = "unknown";
    }
  }
  let driverVersion = CUA_DRIVER_ARTIFACT_PROVENANCE.version;
  if (appPath) {
    try {
      const provenance = JSON.parse(
        await readFile(
          path.join(appPath, "Contents", "Resources", "computer-use", "cua-driver-artifact.json"),
          "utf8",
        ),
      );
      if (typeof provenance?.version === "string" && provenance.version.trim()) {
        driverVersion = provenance.version.trim();
      }
    } catch {
      // Fall back to the compiled pin version.
    }
  }
  const macOSVersion = await readHostMacOSVersion({ platform, exec });
  return { appVersion, driverVersion, macOSVersion };
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

function writeSse(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function writeTextCompletion(response, { id, model, content }) {
  writeSse(response, {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  });
  writeSse(response, {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
}

export async function startAcceptanceModel({
  capability,
  expectedTitles,
  decoyTitles = null,
  readGates,
  readDeniedGates = null,
  onSampleCursor = null,
  onDeniedObserved = null,
}) {
  const twoWindow = Array.isArray(decoyTitles) && decoyTitles.length > 0;
  const requests = [];
  const issuedCalls = [];
  const deniedRequests = [];
  let target = null;
  let decoy = null;
  let gateEvidence = null;
  let deniedGateEvidence = null;
  let deniedResponseText = null;
  let cursorBefore = null;
  let cursorAfter = null;
  let resolveWaitIssued;
  const waitIssued = new Promise((resolve) => {
    resolveWaitIssued = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== acceptanceChatCompletionPath(capability)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readJsonRequest(request);

      if (body?.model === ACCEPTANCE_DENIED_MODEL) {
        const deniedTurn = deniedRequests.length;
        deniedRequests.push(body);
        if (deniedTurn === 0) {
          if (!(await readGates()).globalEnabled) {
            throw new Error("Turn on Computer Use in Settings before sending.");
          }
        }
        if (deniedTurn === 1) {
          deniedGateEvidence = readDeniedGates ? await readDeniedGates() : null;
          try {
            deniedResponseText = correlatedToolMessage(body, 0, "aiden-cua-denied").content;
          } catch (error) {
            deniedResponseText = error instanceof Error ? error.message : String(error);
          }
          if (onDeniedObserved) await onDeniedObserved();
        }
        const args = acceptanceDeniedToolCall(deniedTurn);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/event-stream",
        });
        const chunks = openAiToolCallChunks(deniedTurn, args, {
          model: ACCEPTANCE_DENIED_MODEL,
          callPrefix: "aiden-cua-denied",
        });
        if (chunks) {
          for (const chunk of chunks) writeSse(response, chunk);
        } else {
          writeTextCompletion(response, {
            id: "chatcmpl-aiden-cua-denied-complete",
            model: ACCEPTANCE_DENIED_MODEL,
            content: "Denied check complete. Switch to the 'Computer Use acceptance' chat.",
          });
        }
        response.end("data: [DONE]\n\n");
        return;
      }

      const turn = requests.length;
      requests.push(body);
      if (turn === 0) {
        // The access card appears on the first computer_use call, so only the
        // beta can be on before the prompt is sent.
        if (!(await readGates()).globalEnabled) {
          throw new Error("Turn on Computer Use in Settings before sending.");
        }
      }
      if (turn === 1) {
        // The first computer_use call ran, so the operator allowed the chat.
        gateEvidence = await readGates();
        if (!gateEvidence.accessGranted) {
          throw new Error("Choose Allow for this chat on the Computer Use access card.");
        }
      }
      if (turn === 2) {
        if (twoWindow) {
          ({ target, decoy } = resolveAcceptanceWindows(body, {
            targetTitles: expectedTitles,
            decoyTitles,
          }));
        } else {
          target = resolveAcceptanceTarget(body, expectedTitles);
        }
      }
      if (turn === 5 && onSampleCursor) {
        cursorBefore = await onSampleCursor("before");
      }
      if (turn === 7 && onSampleCursor) {
        cursorAfter = await onSampleCursor("after");
      }
      const args = acceptanceToolCall(turn, target, decoy);
      issuedCalls.push(args);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
      });
      const chunks = openAiToolCallChunks(turn, args);
      if (chunks) {
        for (const chunk of chunks) writeSse(response, chunk);
      } else {
        writeTextCompletion(response, {
          id: "chatcmpl-aiden-cua-complete",
          model: ACCEPTANCE_MODEL,
          content: "Acceptance sequence reached its end.",
        });
      }
      response.end("data: [DONE]\n\n");
      if (args?.action === "wait") resolveWaitIssued();
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback model did not bind TCP.");
  return {
    port: address.port,
    requests,
    issuedCalls,
    deniedRequests,
    waitIssued,
    target: () => target,
    decoy: () => decoy,
    gateEvidence: () => gateEvidence,
    deniedGateEvidence: () => deniedGateEvidence,
    deniedResponseText: () => deniedResponseText,
    cursorSamples: () => ({ before: cursorBefore, after: cursorAfter }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function seedAcceptanceUserData(userData, port, capability) {
  const fixture = acceptanceFixture(port, capability);
  const chats = path.join(userData, "chats");
  await mkdir(chats, { recursive: true });
  await Promise.all([
    writeFile(path.join(userData, "config.json"), JSON.stringify(fixture.config, null, 2), "utf8"),
    writeFile(path.join(chats, "index.json"), JSON.stringify(fixture.index, null, 2), "utf8"),
    writeFile(
      path.join(chats, `${fixture.chat.id}.json`),
      JSON.stringify(fixture.chat, null, 2),
      "utf8",
    ),
    writeFile(
      path.join(chats, `${fixture.deniedChat.id}.json`),
      JSON.stringify(fixture.deniedChat, null, 2),
      "utf8",
    ),
  ]);
}

async function readAcceptanceGates(userData, chatId = "computer-use-acceptance") {
  const [config, chat] = await Promise.all([
    readFile(path.join(userData, "config.json"), "utf8").then(JSON.parse),
    readFile(path.join(userData, "chats", `${chatId}.json`), "utf8").then(JSON.parse),
  ]);
  return acceptanceGateEvidence(config, chat);
}

async function processTable() {
  const { stdout } = await executeFile("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  });
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

async function executableProcesses(executable) {
  return (await processTable()).filter(
    (processInfo) =>
      processInfo.command === executable || processInfo.command.startsWith(`${executable} `),
  );
}

function commandMatchesExecutable(command, executable) {
  return command === executable || command.startsWith(`${executable} `);
}

async function commandForPid(pid) {
  try {
    const { stdout } = await executeFile("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
}

async function waitForProcessExit(processInfo, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await commandForPid(processInfo.pid)) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
  }
  return (await commandForPid(processInfo.pid)) === null;
}

async function signalTrackedProcess(processInfo, signal) {
  const command = await commandForPid(processInfo.pid);
  if (command === null) return;
  if (command !== processInfo.executable && !command.startsWith(`${processInfo.executable} `)) {
    throw new Error(`Refusing to signal reused pid ${processInfo.pid}: ${command}`);
  }
  try {
    await executeFile("/bin/kill", [`-${signal}`, String(processInfo.pid)]);
  } catch (error) {
    if ((await commandForPid(processInfo.pid)) !== null) throw error;
  }
}

async function terminateTrackedProcess(processInfo) {
  if (!processInfo) return;
  await signalTrackedProcess(processInfo, "TERM");
  if (await waitForProcessExit(processInfo, 5_000)) return;
  await signalTrackedProcess(processInfo, "KILL");
  if (!(await waitForProcessExit(processInfo, 5_000))) {
    throw new Error(`Tracked process ${processInfo.pid} did not exit after SIGKILL.`);
  }
}

async function discoveredTextEditPaths() {
  try {
    const { stdout } = await executeFile(
      "/usr/bin/mdfind",
      [`kMDItemCFBundleIdentifier == '${TEXTEDIT_BUNDLE_ID}'`],
      { encoding: "utf8" },
    );
    return stdout
      .split("\n")
      .map((candidate) => candidate.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function textEditBundleIdentifier(appPath) {
  const { stdout } = await executeFile(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      path.join(appPath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

export async function resolveTextEditExecutable({
  knownPaths = TEXTEDIT_KNOWN_PATHS,
  discover = discoveredTextEditPaths,
  canonicalize = realpath,
  readBundleIdentifier = textEditBundleIdentifier,
  inspect = lstat,
} = {}) {
  const candidates = [...knownPaths, ...(await discover())];
  const inspected = new Set();
  for (const candidate of candidates) {
    try {
      const appPath = await canonicalize(candidate);
      if (inspected.has(appPath)) continue;
      inspected.add(appPath);
      if ((await readBundleIdentifier(appPath)) !== TEXTEDIT_BUNDLE_ID) continue;
      const executable = await canonicalize(path.join(appPath, "Contents", "MacOS", "TextEdit"));
      const info = await inspect(executable);
      if (info.isFile() && !info.isSymbolicLink()) return executable;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Could not resolve a canonical ${TEXTEDIT_BUNDLE_ID} executable.`);
}

async function observeAndTerminateCreatedProcesses({
  executable,
  before,
  listProcesses,
  terminate,
  sleep,
  now,
  observationMs,
}) {
  const errors = [];
  const deadline = now() + observationMs;
  let firstObservation = true;
  while (firstObservation || now() < deadline) {
    firstObservation = false;
    const created = (await listProcesses(executable)).filter((entry) => !before.has(entry.pid));
    for (const entry of created) {
      try {
        await terminate({ ...entry, executable });
      } catch (error) {
        errors.push(error);
      }
    }
    if (now() >= deadline) break;
    await sleep();
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Could not clean every TextEdit process created by the launcher.",
    );
  }
}

export async function launchTrackedApplicationProcess({
  executable,
  launch,
  listProcesses = executableProcesses,
  terminate = terminateTrackedProcess,
  sleep = () => new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS)),
  now = Date.now,
  timeoutMs = 10_000,
  cleanupObservationMs = 1_000,
}) {
  const before = new Set((await listProcesses(executable)).map((entry) => entry.pid));
  try {
    await launch();
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const created = (await listProcesses(executable)).filter((entry) => !before.has(entry.pid));
      if (created.length === 1) return { ...created[0], executable };
      if (created.length > 1) {
        throw new Error(
          "Launching the disposable TextEdit document created multiple new processes.",
        );
      }
      await sleep();
    }
    throw new Error("The disposable TextEdit process did not start within 10 seconds.");
  } catch (error) {
    try {
      await observeAndTerminateCreatedProcesses({
        executable,
        before,
        listProcesses,
        terminate,
        sleep,
        now,
        observationMs: cleanupObservationMs,
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "The disposable TextEdit launch failed and cleanup was incomplete.",
      );
    }
    throw error;
  }
}

async function launchDisposableTextEdit(targetFile, decoyFile = null) {
  const executable = await resolveTextEditExecutable();
  const appPath = path.dirname(path.dirname(path.dirname(executable)));
  const files = decoyFile ? [targetFile, decoyFile] : [targetFile];
  return launchTrackedApplicationProcess({
    executable,
    launch: () => executeFile("/usr/bin/open", ["-na", appPath, ...files]),
  });
}

async function assertNoRunningAiden(appPath) {
  const executable = path.join(appPath, "Contents", "MacOS", "Aiden Agent");
  if ((await executableProcesses(executable)).length > 0) {
    throw new Error("Quit every running Aiden window before starting the isolated acceptance run.");
  }
  if ((await lingeringComputerUseProcesses(appPath)).length > 0) {
    throw new Error("A Computer Use helper from this package is already running.");
  }
}

export function computerUseHelperExecutables(appPath) {
  const helperRoot = path.join(
    appPath,
    "Contents",
    "Helpers",
    "CuaDriver.app",
    "Contents",
    "MacOS",
  );
  return [path.join(helperRoot, "aiden-cua-broker"), path.join(helperRoot, "cua-driver")];
}

export function bindOwnedProcesses(processes, executables) {
  const owned = [];
  for (const entry of processes) {
    const executable = executables.find((candidate) =>
      commandMatchesExecutable(entry.command, candidate),
    );
    if (executable) owned.push({ ...entry, executable });
  }
  return owned;
}

async function lingeringComputerUseProcesses(appPath) {
  return bindOwnedProcesses(await processTable(), computerUseHelperExecutables(appPath));
}

export async function waitForCleanComputerUseExit(
  appPath,
  {
    list = lingeringComputerUseProcesses,
    sleep = () => new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS)),
    now = Date.now,
    timeoutMs = 10_000,
    cleanSettleMs = 500,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let cleanSince = null;
  while (now() <= deadline) {
    const lingering = await list(appPath);
    if (lingering.length === 0) {
      cleanSince ??= now();
      if (now() - cleanSince >= cleanSettleMs) return;
    } else {
      cleanSince = null;
    }
    if (now() >= deadline) break;
    await sleep();
  }
  throw new Error("A Computer Use broker or driver remained after packaged Aiden exited.");
}

export async function terminateLingeringComputerUseProcesses(
  appPath,
  {
    list = lingeringComputerUseProcesses,
    terminate = terminateTrackedProcess,
    sleep = () => new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS)),
    now = Date.now,
    timeoutMs = 10_000,
    cleanSettleMs = 500,
  } = {},
) {
  const errors = [];
  const deadline = now() + timeoutMs;
  let cleanSince = null;
  while (now() <= deadline) {
    const lingering = await list(appPath);
    if (lingering.length === 0) {
      cleanSince ??= now();
      if (now() - cleanSince >= cleanSettleMs) break;
    } else {
      cleanSince = null;
      for (const processInfo of lingering) {
        try {
          await terminate(processInfo);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (now() >= deadline) break;
    await sleep();
  }

  const remaining = await list(appPath);
  for (const processInfo of remaining) {
    try {
      await terminate(processInfo);
    } catch (error) {
      errors.push(error);
    }
  }
  const finalRemaining = await list(appPath);
  if (finalRemaining.length > 0) {
    errors.push(
      new Error(
        `Package-owned Computer Use helpers remained after cleanup: ${finalRemaining
          .map((entry) => entry.pid)
          .join(", ")}`,
      ),
    );
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Could not terminate every package-owned Computer Use helper.",
    );
  }
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

function forwardChildOutput(child) {
  let observed = false;
  let resolveObserved;
  const promise = new Promise((resolve) => {
    resolveObserved = resolve;
  });
  const forward = (stream, destination) => {
    let pending = "";
    stream?.on("data", (chunk) => {
      destination.write(chunk);
      pending = `${pending}${chunk.toString("utf8")}`.slice(-16_384);
      if (!observed && /\[chat\].*"event":"renderer_user_stop"/u.test(pending)) {
        observed = true;
        resolveObserved();
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return { promise, observed: () => observed };
}

function beforeDeadline(promise, deadline, message) {
  const timeoutMs = Math.max(1, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function waitForStopTeardown({
  appPath,
  childState,
  model,
  stopAudit,
  deadline,
  expectedToolCount = ACCEPTANCE_TOOL_COUNT,
  listHelpers = lingeringComputerUseProcesses,
  sleep = () => new Promise((resolve) => setTimeout(resolve, PROCESS_POLL_MS)),
  now = Date.now,
  cleanSettleMs = 500,
}) {
  const first = await beforeDeadline(
    Promise.race([
      model.waitIssued.then(() => ({ kind: "wait" })),
      childState.promise.then((outcome) => ({ kind: "exit", outcome })),
    ]),
    deadline,
    "The acceptance sequence never reached its cancellable wait action.",
  );
  if (first.kind === "exit") {
    throw new Error("Aiden exited before the Stop action could be validated.");
  }

  if (stopAudit.observed()) {
    throw new Error("The renderer Stop control fired before the cancellable wait began.");
  }

  let observedHelper = false;
  let observedStop = false;
  let cleanSince = null;
  while (now() < deadline) {
    if (childState.outcome()) {
      throw new Error("Aiden quit before Stop reaped Computer Use while the app was still alive.");
    }
    if (model.requests.length > expectedToolCount) {
      throw new Error("The 30-second wait completed instead of being cancelled with Stop.");
    }
    const helpers = await listHelpers(appPath);
    if (helpers.length > 0) {
      observedHelper = true;
      cleanSince = null;
    }
    if (stopAudit.observed()) observedStop = true;
    if (observedStop && observedHelper && helpers.length === 0) {
      cleanSince ??= now();
      if (now() - cleanSince >= cleanSettleMs) {
        if (childState.outcome()) {
          throw new Error(
            "Aiden quit before Stop reaped Computer Use while the app was still alive.",
          );
        }
        return {
          observedHelperBeforeStop: true,
          observedUserStop: true,
          helpersAfterStop: [],
        };
      }
    }
    await sleep();
  }
  throw new Error(
    !observedHelper
      ? "The packaged Computer Use helper was never observed during the wait action."
      : !observedStop
        ? "No explicit renderer user-Stop marker was observed before the acceptance deadline."
        : "Stop did not reap Computer Use before the acceptance deadline.",
  );
}

export async function emergencyCleanup(
  { appPath, aidenProcess, textEditProcess, model },
  {
    terminateProcess = terminateTrackedProcess,
    terminateComputerUse = terminateLingeringComputerUseProcesses,
    closeModel = (activeModel) => activeModel?.close(),
  } = {},
) {
  const errors = [];
  for (const operation of [
    () => terminateProcess(aidenProcess),
    () => (appPath ? terminateComputerUse(appPath) : Promise.resolve()),
    () => terminateProcess(textEditProcess),
    () => closeModel(model),
  ]) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function runAcceptance() {
  let metadata = await readPackagedMetadata({ root: repositoryRoot });
  const support = evaluateHostSupport({
    platform: process.platform,
    macOSVersion: metadata.macOSVersion,
  });
  if (!support.supported) {
    const unsupportedReport = buildUnsupportedRealDesktopReport(metadata, support.reason);
    console.log(`\n${renderRealDesktopReport(unsupportedReport)}`);
    await invalidateComputerUseAcceptanceReceipt(repositoryRoot).catch(() => {});
    throw new Error(support.reason);
  }
  if (process.env.AIDEN_COMPUTER_USE_ACCEPTANCE !== "1") {
    throw new Error(
      "This test can request macOS Accessibility and Screen Recording. Re-run with AIDEN_COMPUTER_USE_ACCEPTANCE=1 after reviewing the checklist.",
    );
  }

  await invalidateComputerUseAcceptanceReceipt(repositoryRoot);
  const receiptPath = resolveComputerUseAcceptanceReceipt(repositoryRoot);
  const appPath = path.resolve(
    argumentValue("--app") ??
      (await discoverPackagedApp(path.join(repositoryRoot, "release", "development"))),
  );
  await verifyMacPackage(appPath);
  await assertNoRunningAiden(appPath);
  const artifact = await packagedArtifactIdentity(appPath);
  metadata = await readPackagedMetadata({ root: repositoryRoot, appPath, artifact });

  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-acceptance-"));
  const userData = path.join(temporary, "user-data");
  const runId = path.basename(temporary);
  const targetName = `Aiden CUA Target ${runId}.txt`;
  const decoyName = `Aiden CUA Decoy ${runId}.txt`;
  const targetFile = path.join(temporary, targetName);
  const decoyFile = path.join(temporary, decoyName);
  const expectedTitles = [targetName, path.parse(targetName).name];
  const decoyTitles = [decoyName, path.parse(decoyName).name];
  const modelCapability = randomBytes(32).toString("base64url");
  let model = null;
  let textEditProcess = null;
  let aidenProcess = null;
  let failure = null;
  let completed = false;
  let realDesktopReport = null;
  let deniedDiskSnapshots = null;
  let cursorProbeError = null;
  let stopEvidence = null;

  try {
    await Promise.all([
      writeFile(targetFile, ACCEPTANCE_TARGET_INITIAL_TEXT, "utf8"),
      writeFile(decoyFile, ACCEPTANCE_DECOY_INITIAL_TEXT, "utf8"),
    ]);
    textEditProcess = await launchDisposableTextEdit(targetFile, decoyFile);
    model = await startAcceptanceModel({
      capability: modelCapability,
      expectedTitles,
      decoyTitles,
      readGates: () => readAcceptanceGates(userData, "computer-use-acceptance"),
      readDeniedGates: () => readAcceptanceGates(userData, "computer-use-acceptance-denied"),
      onDeniedObserved: async () => {
        const [targetAfterDenied, decoyAfterDenied] = await Promise.all([
          readFile(targetFile, "utf8"),
          readFile(decoyFile, "utf8"),
        ]);
        deniedDiskSnapshots = { target: targetAfterDenied, decoy: decoyAfterDenied };
      },
      onSampleCursor: async () => {
        try {
          return await readHostCursorPosition();
        } catch (error) {
          cursorProbeError = error instanceof Error ? error.message : String(error);
          return null;
        }
      },
    });
    await seedAcceptanceUserData(userData, model.port, modelCapability);

    const executable = path.join(appPath, "Contents", "MacOS", "Aiden Agent");
    const child = spawn(executable, [`--user-data-dir=${userData}`], {
      env: { ...process.env, AIDEN_ANALYTICS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) throw new Error("The packaged Aiden process did not start.");
    aidenProcess = { pid: child.pid, executable };
    const childState = monitorChild(child);
    const stopAudit = forwardChildOutput(child);
    const deadline = Date.now() + ACCEPTANCE_TIMEOUT_MS;

    console.log(`\nPackaged Computer Use acceptance is running in: ${temporary}`);
    console.log(
      `App ${metadata.appVersion} · cua-driver ${metadata.driverVersion} · macOS ${metadata.macOSVersion}`,
    );
    console.log("1. In Settings → Computers & VMs → Computer Use, turn on the global beta gate.");
    console.log("2. Request access if macOS reports missing permissions.");
    console.log("3. Open “Computer Use acceptance (denied)”, send a message, and choose Deny on the access card.");
    console.log("4. Open “Computer Use acceptance” and send: “Run the packaged Computer Use acceptance sequence.”");
    console.log("5. On the Computer Use access card, choose Allow in this chat — then keep hands off the mouse until the 30-second wait starts.");
    console.log("6. Both TextEdit windows stay open; only the Target window changes, the Decoy stays unchanged, and the stale click is rejected.");
    console.log("7. When the 30-second wait starts, press Stop but keep Aiden open.");
    console.log("8. Quit Aiden normally only after this terminal confirms Stop teardown.");
    console.log("No model data leaves this Mac; the provider listens only on 127.0.0.1.");
    console.log(
      "macOS TCC grants persist after this test; revoke them in System Settings if you no longer want Aiden Computer Use access.\n",
    );

    stopEvidence = await waitForStopTeardown({
      appPath,
      childState,
      model,
      stopAudit,
      deadline,
      expectedToolCount: ACCEPTANCE_TWO_WINDOW_TOOL_COUNT,
    });
    console.log("Stop teardown observed while Aiden is still running. Quit Aiden normally now.");
    const exit = await beforeDeadline(
      childState.promise,
      deadline,
      "Packaged Computer Use acceptance timed out after 15 minutes.",
    );
    if (exit.error) throw exit.error;
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`Packaged Aiden did not exit normally (${exit.code ?? exit.signal}).`);
    }
    aidenProcess = null;
    await waitForCleanComputerUseExit(appPath);
    const helpersAfterQuit = await lingeringComputerUseProcesses(appPath);

    const [savedText, decoySavedText] = await Promise.all([
      readFile(targetFile, "utf8"),
      readFile(decoyFile, "utf8"),
    ]);
    const evidence = evaluateAcceptanceRequests(model.requests, {
      expectedTitles,
      decoyTitles,
      savedText,
      decoySavedText,
    });
    const resolvedTarget = model.target();
    const resolvedDecoy = model.decoy();
    const targetMatched = Boolean(resolvedTarget && resolvedTarget.pid === textEditProcess.pid);
    const { before: cursorBefore, after: cursorAfter } = model.cursorSamples();

    const checkRows = [
      evaluateTextEditMarkerCheck({
        metadata,
        targetFileText: savedText,
        initialText: ACCEPTANCE_TARGET_INITIAL_TEXT,
        expectedMarker: ACCEPTANCE_SAVED_TEXT,
        targetMatched,
      }),
      evaluateTwoWindowsIsolationCheck({
        metadata,
        targetWindow: resolvedTarget,
        decoyWindow: resolvedDecoy,
        targetFileText: savedText,
        decoyFileBefore: ACCEPTANCE_DECOY_INITIAL_TEXT,
        decoyFileAfter: decoySavedText,
        decoyLiveCaptureText: evidence.decoyLiveCaptureText,
        expectedMarker: ACCEPTANCE_SAVED_TEXT,
        cursorBefore,
        cursorAfter,
        environmentError: cursorProbeError,
      }),
      evaluateStopCleanupCheck({
        metadata,
        observedHelperBeforeStop: stopEvidence?.observedHelperBeforeStop === true,
        observedUserStop: stopEvidence?.observedUserStop === true,
        helpersAfterStop: stopEvidence?.helpersAfterStop ?? [],
        helpersAfterQuit,
      }),
      evaluateDeniedPermissionCheck({
        metadata,
        deniedResponseText: model.deniedResponseText(),
        accessGranted: model.deniedGateEvidence()?.accessGranted ?? false,
        targetFileBefore: ACCEPTANCE_TARGET_INITIAL_TEXT,
        targetFileAfter: deniedDiskSnapshots?.target ?? null,
        decoyFileBefore: ACCEPTANCE_DECOY_INITIAL_TEXT,
        decoyFileAfter: deniedDiskSnapshots?.decoy ?? null,
        deniedMarker: ACCEPTANCE_DENIED_TEXT,
      }),
    ];

    realDesktopReport = {
      schemaVersion: 1,
      ...metadata,
      checks: checkRows,
    };
    const reportEval = evaluateRealDesktopReport(realDesktopReport);
    console.log(`\n${renderRealDesktopReport(realDesktopReport)}`);

    if (model.issuedCalls.length !== ACCEPTANCE_TWO_WINDOW_TOOL_COUNT) {
      throw new Error(`Only ${model.issuedCalls.length} scripted Computer Use calls were issued.`);
    }
    const gateEvidence = model.gateEvidence();
    if (!gateEvidence?.globalEnabled || !gateEvidence?.accessGranted) {
      throw new Error(
        "The operator did not turn on Computer Use and allow the acceptance chat.",
      );
    }
    if (!targetMatched) {
      throw new Error(
        "Computer Use did not bind to the newly launched disposable TextEdit process.",
      );
    }
    if (!evidence.ok) throw new Error(evidence.failures.join(" "));
    if (!reportEval.ok) {
      const checkDetails = realDesktopReport.checks
        .filter((check) => check.status !== "pass")
        .map((check) => `${check.id} (${check.status}): ${check.detail}`);
      const reasons = [...checkDetails, ...reportEval.failures];
      throw new Error(
        `Real-desktop acceptance did not pass (${reportEval.overallStatus}): ${reasons.join(" ")}`,
      );
    }

    await terminateTrackedProcess(textEditProcess);
    textEditProcess = null;
    await model.close();
    model = null;
    await rm(temporary, { recursive: true, force: true });

    await writeComputerUseAcceptanceReceipt(
      JSON.stringify(
        {
          schemaVersion: 4,
          completedAt: new Date().toISOString(),
          ...metadata,
          artifact,
          modelTransport: "capability_authenticated_loopback",
          realDesktopReport,
          checks: [
            "global_gate_enabled_through_settings",
            "chat_access_allowed_through_access_card",
            "denied_permission_changes_nothing",
            "exact_disposable_textedit_target",
            "two_windows_isolation_and_cursor",
            "list_apps",
            "list_windows",
            "capture_ax",
            "capture_vision",
            "capture_som",
            "type",
            "capture_after",
            "save_key",
            "saved_file_marker",
            "stale_element_rejected",
            "explicit_renderer_user_stop_event",
            "stop_teardown_before_quit",
            "normal_app_quit",
            "helper_processes_reaped",
          ],
        },
        null,
        2,
      ),
      repositoryRoot,
    );
    completed = true;
    console.log(`Packaged Computer Use acceptance passed. Receipt: ${receiptPath}`);
  } catch (error) {
    failure = error;
    if (!realDesktopReport) {
      const status = classifyAcceptanceError(error);
      const detail = error instanceof Error ? error.message : String(error);
      realDesktopReport = {
        schemaVersion: 1,
        ...metadata,
        checks: REAL_DESKTOP_CHECK_IDS.map((id) => ({
          id,
          status,
          detail,
          ...metadata,
        })),
      };
      console.log(`\n${renderRealDesktopReport(realDesktopReport)}`);
    }
    await writeFile(
      path.join(temporary, "real-desktop-report.json"),
      `${JSON.stringify(realDesktopReport, null, 2)}\n`,
      "utf8",
    ).catch(() => {});
  } finally {
    if (!completed) {
      await invalidateComputerUseAcceptanceReceipt(repositoryRoot).catch(() => {});
      const cleanupErrors = await emergencyCleanup({
        appPath,
        aidenProcess,
        textEditProcess,
        model,
      });
      console.error(`Acceptance evidence was kept for diagnosis at ${temporary}`);
      if (cleanupErrors.length > 0) {
        failure = new AggregateError(
          [failure, ...cleanupErrors].filter(Boolean),
          "Packaged acceptance failed and emergency cleanup reported errors.",
        );
      }
    }
  }
  if (failure) throw failure;
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) await runAcceptance();
