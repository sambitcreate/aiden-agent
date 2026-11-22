// Electron binding of keep-awake (docs/plans/proactive-aiden-plan.md, C1 and C3).
//
// Holds one `prevent-app-suspension` power-save blocker while Aiden works:
// the display can still sleep, and closing a Mac's lid still sleeps it unless
// it runs in clamshell mode. On Linux Electron asks the desktop's inhibit
// service over D-Bus, which is best-effort. Released at quit.

import { ipcMain, logger, onBroadcast, powerMonitor, powerSaveBlocker } from "../../platform.js";
import {
  KEEP_AWAKE_CHANGED_CHANNEL,
  KEEP_AWAKE_UNSUPPORTED,
  type KeepAwakeStatus,
} from "../../../renderer/shared/keep-awake.js";
import { configStore } from "../config-store.js";
import { backgroundJobs, checkBacks, goalChecks } from "../follow-through/follow-through-main.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";
import { hostRunRegistry } from "../host-runs-main.js";
import { usageLimits } from "../usage-limit-main.js";
import { KeepAwakeController, type KeepAwakeInput } from "./keep-awake-core.js";
import {
  backgroundJobKeepAwakeInput,
  doneWhenKeepAwakeInput,
  dueSoonKeepAwakeInput,
  hostRunKeepAwakeInput,
  usageLimitKeepAwakeInput,
  type KeepAwakeDue,
} from "./keep-awake-inputs.js";

let controller: KeepAwakeController<number, ReturnType<typeof setTimeout>> | undefined;
const unsubscribers: Array<() => void> = [];

/** What the Settings row shows. */
export function keepAwakeStatus(): KeepAwakeStatus {
  return controller?.status() ?? KEEP_AWAKE_UNSUPPORTED;
}

/** Adds a later input (goals) to the running controller. */
export function addKeepAwakeInput(input: KeepAwakeInput): () => void {
  return controller?.addInput(input) ?? (() => undefined);
}

/**
 * Pending Bot wake-ups, read from the schedule store. The store reads
 * asynchronously and inputs read synchronously, so this keeps a copy that is
 * refreshed whenever routines or schedules change.
 */
let pendingWakeUps: readonly KeepAwakeDue[] = [];
let wakeUpRead: Promise<void> | undefined;
let wakeUpReadAgain = false;

function refreshWakeUps(): void {
  if (wakeUpRead) {
    wakeUpReadAgain = true;
    return;
  }
  wakeUpRead = (async () => {
    try {
      // Loaded lazily, like the Bot wake-up wiring: the scheduler must not load early.
      const { scheduleStore } = await import("../schedule-store.js");
      pendingWakeUps = (await scheduleStore.list()).flatMap((task) =>
        task.wakeUp !== undefined && task.enabled && task.nextRunAt !== undefined
          ? [{ id: task.id, fireAt: task.nextRunAt }]
          : [],
      );
    } catch (error) {
      logger.warn("keep-awake", "Could not read pending Bot wake-ups.", error);
    }
    controller?.update();
  })().finally(() => {
    wakeUpRead = undefined;
    if (wakeUpReadAgain) {
      wakeUpReadAgain = false;
      refreshWakeUps();
    }
  });
}

async function readEnabled(): Promise<boolean> {
  try {
    return (await configStore.getSettings()).keepAwakeWhileWorking !== false;
  } catch (error) {
    logger.warn("keep-awake", "Could not read the keep-awake setting.", error);
    return true;
  }
}

/** Starts watching work. Safe to call once the app is ready; a no-op off macOS and Linux. */
export async function startKeepAwake(): Promise<void> {
  if (controller || !hostPlatformCapabilities().keepAwake) return;
  let wasHolding = false;
  const created = new KeepAwakeController<number, ReturnType<typeof setTimeout>>({
    blocker: {
      start: () => powerSaveBlocker.start("prevent-app-suspension"),
      stop: (id) => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      },
    },
    clock: {
      now: Date.now,
      setTimeout: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return timer;
      },
      clearTimeout: (timer) => clearTimeout(timer),
    },
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    enabled: await readEnabled(),
    onStatus: (status) => {
      if (status.holding !== wasHolding) {
        wasHolding = status.holding;
        logger.info("keep-awake", status.holding ? "Keeping the computer awake." : "Not keeping the computer awake.");
      }
      ipcMain.broadcast(KEEP_AWAKE_CHANGED_CHANNEL, status);
    },
    onError: (error) => logger.warn("keep-awake", "Keep-awake could not read an input or change the hold.", error),
  });
  if (controller) {
    created.dispose();
    return;
  }
  controller = created;

  // Services announce changes in bursts; one re-read per turn of the event loop is enough.
  let queued = false;
  const update = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      controller?.update();
    });
  };
  const waits = () => usageLimits.gate.waits();
  created.addInput(hostRunKeepAwakeInput({ runs: () => hostRunRegistry.list(), waits }));
  created.addInput(usageLimitKeepAwakeInput(waits));
  created.addInput(backgroundJobKeepAwakeInput(() => backgroundJobs.listAll()));
  created.addInput(doneWhenKeepAwakeInput(() => goalChecks.list()));
  created.addInput(
    dueSoonKeepAwakeInput({
      checkBacks: () => checkBacks.pendingAll(),
      wakeUps: () => pendingWakeUps,
      onBattery: () => powerMonitor.isOnBatteryPower(),
    }),
  );
  refreshWakeUps();

  // Plugging in or unplugging (macOS; Linux is re-read on a timer by the input),
  // and waking from sleep, which can move due times into the window.
  const powerChanged = () => update();
  const resumed = () => refreshWakeUps();
  powerMonitor.on("on-ac", powerChanged);
  powerMonitor.on("on-battery", powerChanged);
  powerMonitor.on("resume", resumed);

  unsubscribers.push(
    hostRunRegistry.onChange(update),
    usageLimits.gate.onChange(update),
    () => {
      powerMonitor.removeListener("on-ac", powerChanged);
      powerMonitor.removeListener("on-battery", powerChanged);
      powerMonitor.removeListener("resume", resumed);
    },
    onBroadcast((channel) => {
      // Jobs (including their ports), checks and check-backs announce themselves here.
      if (channel === "chats:follow-through-changed") update();
      // Bot routines (and so Bot wake-ups) changed.
      else if (channel === "bots:changed") refreshWakeUps();
      // The Settings switch saves through the scheduled-task settings, and a
      // routine run (a Bot wake-up firing) reports here too.
      else if (channel === "schedule:updated") {
        refreshWakeUps();
        void readEnabled().then((enabled) => controller?.setEnabled(enabled));
      }
    }),
  );
}

/** Lets go of the hold and stops watching; for quit. */
export function stopKeepAwake(): void {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  controller?.dispose();
  controller = undefined;
  pendingWakeUps = [];
}
