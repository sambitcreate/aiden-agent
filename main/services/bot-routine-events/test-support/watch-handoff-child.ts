// Process-death fixture: the parent kills us at a real durable hand-off boundary.
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { createBotEventRoutineStore } from "../store.js";
import { createBotRoutineEventDispatcher } from "../dispatcher.js";
import { createBotWatches } from "../watch.js";

const [profileDir, routineId, stage, timestamp] = process.argv.slice(2);
if (!profileDir || !routineId || !["before", "after"].includes(stage ?? "")) throw new Error("Invalid fixture arguments.");
const now = () => Number(timestamp);
const store = createBotEventRoutineStore({ profileDir: () => profileDir, now });
const dispatcher = createBotRoutineEventDispatcher({
  store,
  run: async (_routine, event) => { await appendFile(path.join(profileDir, "delivered.txt"), `${event.eventId}\n`); },
  isPaused: async () => false,
  now,
  timeZone: () => "UTC",
  setTimer: () => ({ cancel() {} }),
});
const watches = createBotWatches({
  store,
  routines: () => store.all(),
  check: async () => ({ ok: true, bytes: new TextEncoder().encode("status: red") }),
  dispatcher: { emit: async (...args) => {
    if (stage === "after") {
      await dispatcher.emit(...args);
      await dispatcher.idle();
    }
    process.send?.("staged");
    return new Promise(() => {});
  } },
  isPaused: async () => false,
  paused: async () => {},
  recovered: async () => {},
  now,
  setTimer: () => ({ cancel() {} }),
});
await watches.checkNow("bot-a", routineId);
