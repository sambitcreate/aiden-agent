/* global process, setInterval */

// Child process for the Bot runtime crash tests. The parent spawns it with
// `node --import tsx kill-harness.mjs <mode> ...`, waits for a marker line on
// stdout, and then SIGKILLs it, so recovery is tested against a real process
// death rather than a simulated close.
//
// Modes:
//   lock <botsDir>                     acquire the profile lock, print LOCK <json>
//   host <profileDir>                  create a host, print HOST <json>
//   stream <profileDir> <botId> <rid>  start a slow streamed answer, print STREAMING <submissionId>
//   scenario <file> <json>             run `run(args, emit)` from a test-owned scenario module

import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { acquireBotProfileLock } from "../profile-lock.ts";
import { createBotHarnessHost } from "../harness-host.ts";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer } from "./faux.ts";

const [mode, ...args] = process.argv.slice(2);
const ctx = BACKGROUND_CONTEXT;

function emit(tag, value) {
  process.stdout.write(`${tag} ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function holdForever() {
  setInterval(() => undefined, 60_000);
}

if (mode === "lock") {
  const result = await acquireBotProfileLock(args[0]);
  emit("LOCK", result.ok ? { ok: true } : { ok: false, reason: result.reason, pid: result.pid });
  holdForever();
} else if (mode === "host") {
  const { models } = createFauxModels();
  const host = await createBotHarnessHost({ profileDir: args[0], buildRegistry: () => createRegistry(), models });
  emit("HOST", "unavailable" in host ? { unavailable: host.unavailable } : { ok: true });
  holdForever();
} else if (mode === "stream") {
  const [profileDir, botId, requestId] = args;
  const { models } = createFauxModels([slowAnswer()], { tokensPerSecond: 40 });
  const host = await createBotHarnessHost({ profileDir, buildRegistry: () => createRegistry(), models });
  if ("unavailable" in host) throw new Error("profile locked");
  const { conversation } = await host.open(botId);
  await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  const submission = await conversation.submit({ type: "input", content: "hello", requestId }, ctx);
  const view = await conversation.viewState(ctx);
  let announced = false;
  view.subscribe((value) => {
    if (announced) return;
    if (JSON.stringify(value.docs?.["pi.live"] ?? {}).includes("word word word")) {
      announced = true;
      emit("STREAMING", String(submission.id));
    }
  });
  holdForever();
} else if (mode === "scenario") {
  const [file, json] = args;
  const scenario = await import(pathToFileURL(file).href);
  await scenario.run(JSON.parse(json), emit);
  holdForever();
} else {
  throw new Error(`Unknown mode ${mode}`);
}
