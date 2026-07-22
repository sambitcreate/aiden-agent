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
  ACCEPTANCE_TOOL_COUNT,
  acceptanceChatCompletionPath,
  acceptanceFixture,
  acceptanceToolCall,
  evaluateAcceptanceRequests,
  openAiToolCallChunks,
  resolveAcceptanceTarget,
} from "./computer-use-packaged-acceptance-core.mjs";
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

export async function startAcceptanceModel({ capability, expectedTitles, readGates }) {
  const requests = [];
  const issuedCalls = [];
  let target = null;
  let gateEvidence = null;
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
      const turn = requests.length;
      requests.push(body);
      if (turn === 0) {
        gateEvidence = await readGates();
        if (!gateEvidence.globalEnabled || !gateEvidence.chatEnabled) {
          throw new Error(
            "Enable Computer Use in Settings and in the acceptance chat before sending.",
          );
        }
      }
      if (turn === 2) target = resolveAcceptanceTarget(body, expectedTitles);
      const args = acceptanceToolCall(turn, target);
      issuedCalls.push(args);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
      });
      const chunks = openAiToolCallChunks(turn, args);
      if (chunks) {
        for (const chunk of chunks) writeSse(response, chunk);
      } else {
        writeSse(response, {
          id: "chatcmpl-aiden-cua-complete",
          object: "chat.completion.chunk",
          created: 0,
          model: "aiden-cua-acceptance",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Acceptance sequence reached its end." },
              finish_reason: null,
            },
          ],
        });
        writeSse(response, {
          id: "chatcmpl-aiden-cua-complete",
          object: "chat.completion.chunk",
          created: 0,
          model: "aiden-cua-acceptance",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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
    waitIssued,
    target: () => target,
    gateEvidence: () => gateEvidence,
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
  ]);
}

async function readAcceptanceGates(userData) {
  const [config, chat] = await Promise.all([
    readFile(path.join(userData, "config.json"), "utf8").then(JSON.parse),
    readFile(path.join(userData, "chats", "computer-use-acceptance.json"), "utf8").then(JSON.parse),
  ]);
  return {
    globalEnabled: config?.settings?.computerUseEnabled === true,
    chatEnabled: chat?.computerUseEnabled === true,
  };
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

async function launchDisposableTextEdit(targetFile) {
  const executable = await resolveTextEditExecutable();
  const appPath = path.dirname(path.dirname(path.dirname(executable)));
  return launchTrackedApplicationProcess({
    executable,
    launch: () => executeFile("/usr/bin/open", ["-na", appPath, targetFile]),
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
    if (model.requests.length > ACCEPTANCE_TOOL_COUNT) {
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
        return;
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
  if (process.platform !== "darwin") {
    throw new Error("Packaged Computer Use acceptance is macOS-only.");
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

  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-cua-acceptance-"));
  const userData = path.join(temporary, "user-data");
  const targetName = `Aiden CUA Acceptance ${path.basename(temporary)}.txt`;
  const targetFile = path.join(temporary, targetName);
  const expectedTitles = [targetName, path.parse(targetName).name];
  const modelCapability = randomBytes(32).toString("base64url");
  let model = null;
  let textEditProcess = null;
  let aidenProcess = null;
  let failure = null;
  let completed = false;

  try {
    await writeFile(targetFile, "Aiden Computer Use disposable acceptance window.\n", "utf8");
    textEditProcess = await launchDisposableTextEdit(targetFile);
    model = await startAcceptanceModel({
      capability: modelCapability,
      expectedTitles,
      readGates: () => readAcceptanceGates(userData),
    });
    await seedAcceptanceUserData(userData, model.port, modelCapability);

    const executable = path.join(appPath, "Contents", "MacOS", "Aiden Agent");
    const child = spawn(executable, [`--user-data-dir=${userData}`], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) throw new Error("The packaged Aiden process did not start.");
    aidenProcess = { pid: child.pid, executable };
    const childState = monitorChild(child);
    const stopAudit = forwardChildOutput(child);
    const deadline = Date.now() + ACCEPTANCE_TIMEOUT_MS;

    console.log(`\nPackaged Computer Use acceptance is running in: ${temporary}`);
    console.log("1. In Settings → Computer Use, turn on the global beta gate.");
    console.log("2. Request access if macOS reports missing permissions.");
    console.log("3. Return to the acceptance chat and enable its Computer Use composer control.");
    console.log("4. Send: “Run the packaged Computer Use acceptance sequence.”");
    console.log("5. Choose Allow once for the TextEdit type and save-key prompts.");
    console.log("6. The stale click must be rejected without an approval prompt.");
    console.log("7. When the 30-second wait starts, press Stop but keep Aiden open.");
    console.log("8. Quit Aiden normally only after this terminal confirms Stop teardown.");
    console.log("No model data leaves this Mac; the provider listens only on 127.0.0.1.");
    console.log(
      "macOS TCC grants persist after this test; revoke them in System Settings if you no longer want Aiden Computer Use access.\n",
    );

    await waitForStopTeardown({ appPath, childState, model, stopAudit, deadline });
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

    if (model.issuedCalls.length !== ACCEPTANCE_TOOL_COUNT) {
      throw new Error(`Only ${model.issuedCalls.length} scripted Computer Use calls were issued.`);
    }
    const gateEvidence = model.gateEvidence();
    if (!gateEvidence?.globalEnabled || !gateEvidence?.chatEnabled) {
      throw new Error(
        "The operator did not persist both normal Computer Use gates before sending.",
      );
    }
    const resolvedTarget = model.target();
    if (!resolvedTarget || resolvedTarget.pid !== textEditProcess.pid) {
      throw new Error(
        "Computer Use did not bind to the newly launched disposable TextEdit process.",
      );
    }
    const savedText = await readFile(targetFile, "utf8");
    const evidence = evaluateAcceptanceRequests(model.requests, { expectedTitles, savedText });
    if (!evidence.ok) throw new Error(evidence.failures.join(" "));

    await terminateTrackedProcess(textEditProcess);
    textEditProcess = null;
    await model.close();
    model = null;
    await rm(temporary, { recursive: true, force: true });

    await writeComputerUseAcceptanceReceipt(
      JSON.stringify(
        {
          schemaVersion: 2,
          completedAt: new Date().toISOString(),
          artifact,
          modelTransport: "capability_authenticated_loopback",
          checks: [
            "global_gate_enabled_through_settings",
            "chat_gate_enabled_through_composer",
            "exact_disposable_textedit_target",
            "list_apps",
            "list_windows",
            "capture_ax",
            "capture_vision",
            "capture_som",
            "allow_once_type",
            "capture_after",
            "allow_once_save_key",
            "saved_file_marker",
            "stale_element_rejected_before_approval",
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
