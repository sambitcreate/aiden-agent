// Electron binding of keep-awake (docs/plans/proactive-aiden-plan.md, C1).
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
import { backgroundJobs, doneWhen } from "../follow-through/follow-through-main.js";
import { hostPlatformCapabilities } from "../host-platform-capabilities.js";
import { hostRunRegistry } from "../host-runs-main.js";
import { usageLimits } from "../usage-limit-main.js";
import { KeepAwakeController, type KeepAwakeInput } from "./keep-awake-core.js";
import {
  backgroundJobKeepAwakeInput,
  doneWhenKeepAwakeInput,
  hostRunKeepAwakeInput,
  usageLimitKeepAwakeInput,
} from "./keep-awake-inputs.js";

let controller: KeepAwakeController<number, ReturnType<typeof setTimeout>> | undefined;
const unsubscribers: Array<() => void> = [];

/** What the Settings row shows. */
export function keepAwakeStatus(): KeepAwakeStatus {
  return controller?.status() ?? KEEP_AWAKE_UNSUPPORTED;
}

/** Adds a later input (C3's check-backs due soon, goals) to the running controller. */
export function addKeepAwakeInput(input: KeepAwakeInput): () => void {
  return controller?.addInput(input) ?? (() => undefined);
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
  created.addInput(doneWhenKeepAwakeInput(() => doneWhen.list()));

  unsubscribers.push(
    hostRunRegistry.onChange(update),
    usageLimits.gate.onChange(update),
    onBroadcast((channel) => {
      // Jobs (including their ports) and checks announce themselves here.
      if (channel === "chats:follow-through-changed") update();
      // The Settings switch saves through the scheduled-task settings.
      else if (channel === "schedule:updated") {
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
}
