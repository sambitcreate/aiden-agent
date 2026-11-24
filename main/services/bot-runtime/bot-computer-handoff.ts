// A sign-in card's Open on the Bot's own computer (plan §8.6, `target:
// "computer"`): the `botComputer` opener of `bot-handoff-open.ts`.
//
// - The person takes the computer over first (`takeOver(botId, "sign_in")`).
//   That aborts the Bot's in-flight action, and every later `computer` and
//   `computer_shell` call waits for Give back, so no tool shows the model the
//   screen while the person signs in, and never the password.
// - The guest driver is stopped before the page opens: its LaunchAgent's
//   "enabled" file goes and every process signed as `cua-driver` that runs
//   then is killed. That is one sweep, not a guard: a program the Bot started
//   earlier and left running in the guest could start the driver again while
//   the person signs in (docs/bot-computers.md). The driver lane's bridge
//   starts it again on the Bot's next element step.
// - Then the site opens in Safari in the computer, and the panel's Computer
//   tab comes forward in the window whose Open was pressed.
// - When the card settles or is withdrawn, the computer is given back, unless
//   the person already gave it back or took it again some other way. A card
//   asked again under the same wait id keeps it with the person.
// - Only for a Bot with a computer while Bot computers are on. Anything that
//   fails gives the computer back and opens nothing.
//
// Holds live in memory: an app restart stops the computer, so a hold can't
// outlive it.

import type { BotComputerControl, BotComputerHost, BotComputerTakeOverSource } from "../bot-computers/types.js";
import { guestDriverSuspendScript } from "../bot-computers/guest-driver-install.js";
import {
  BOT_COMPUTER_LINUX_SHELL_USER,
  botComputerGuestOs,
  type BotComputerGuestOs,
} from "../bot-computers/linux-guest-flag.js";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import type { BotHandoffs } from "./bot-handoffs.js";

/** Safari's bundle id on macOS guests: the sign-in page opens there, whatever the default browser is. */
export const BOT_COMPUTER_SIGN_IN_BROWSER = "com.apple.Safari";
/** Browser binary on Linux guests (`AIDEN_BOT_COMPUTERS_LINUX=1`). */
export const BOT_COMPUTER_LINUX_SIGN_IN_BROWSER = "chromium";

const LINUX_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;
const GUEST_COMMAND_TIMEOUT_MS = 30_000;
const GUEST_COMMAND_OUTPUT_BYTES = 4_096;

/**
 * Terminate every process owned by the separate Bot shell user (`aiden-bot`,
 * plan decision 4a) before the person signs in on a Linux guest. Fails closed
 * (exit 76) if the user is missing or any process owned by it survives.
 */
export function botComputerStopShellUserScript(shellUser: string = BOT_COMPUTER_LINUX_SHELL_USER): string {
  if (!LINUX_USER_PATTERN.test(shellUser)) {
    throw new Error(`Invalid Linux shell user name: ${shellUser}`);
  }
  return [
    `u=${quoteRemoteArg(shellUser)}`,
    '/usr/bin/id -u "$u" >/dev/null 2>&1 || exit 76',
    'if /usr/bin/pgrep -u "$u" >/dev/null 2>&1; then',
    '  /usr/bin/sudo -n /usr/bin/pkill -KILL -u "$u" >/dev/null 2>&1 || true',
    "  i=0",
    '  while /usr/bin/pgrep -u "$u" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do',
    "    /bin/sleep 0.1",
    '    /usr/bin/sudo -n /usr/bin/pkill -KILL -u "$u" >/dev/null 2>&1 || true',
    "    i=$((i+1))",
    "  done",
    '  /usr/bin/pgrep -u "$u" >/dev/null 2>&1 && exit 76',
    "fi",
    "exit 0",
  ].join("\n");
}

/** The guest command that opens the sign-in page; `url` is a checked https origin. */
export function botComputerSignInOpenScript(
  url: string,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): string {
  if (guestOs === "linux") {
    return [
      `b=$(command -v ${BOT_COMPUTER_LINUX_SIGN_IN_BROWSER} || command -v chromium-browser) || exit 127`,
      `DISPLAY=:0 nohup "$b" --new-window ${quoteRemoteArg(url)} </dev/null >/dev/null 2>&1 &`,
    ].join("\n");
  }
  return `/usr/bin/open -b ${BOT_COMPUTER_SIGN_IN_BROWSER} ${quoteRemoteArg(url)}`;
}

export interface BotComputerHandoffDeps {
  host: Pick<BotComputerHost, "computer" | "ensureRunning" | "runGuestCommand">;
  control: Pick<BotComputerControl, "controller" | "takeOver" | "giveBack"> & {
    takenOverBy(botId: string): BotComputerTakeOverSource | undefined;
  };
  handoffs: Pick<BotHandoffs, "get" | "onSettled">;
  /** Bot computers are on (the platform flag). */
  enabled(): boolean;
  /** Guest OS target; defaults to `botComputerGuestOs()`. */
  guestOs?: BotComputerGuestOs;
  /** Why an Open opened nothing. */
  onError?(error: unknown): void;
}

/**
 * Hand the Bot's computer to the person for the card `waitId`, opening `url`
 * in Safari there when given (a sign-in always gives one; an action may not).
 * False when nothing opened.
 */
export type BotComputerHandoffOpener = (botId: string, waitId: string, url: string | undefined) => Promise<boolean>;

function heldKey(botId: string, waitId: string): string {
  return `${botId}\u0000${waitId}`;
}

export function createBotComputerHandoffOpener(deps: BotComputerHandoffDeps): BotComputerHandoffOpener {
  /** The cards whose Open took the computer over. */
  const held = new Set<string>();

  const release = (botId: string, waitId: string): void => {
    if (!held.delete(heldKey(botId, waitId))) return;
    // The person may have given it back already, or taken it again from the viewer.
    if (deps.control.controller(botId) === "person" && deps.control.takenOverBy(botId) === "sign_in") {
      deps.control.giveBack(botId);
    }
  };

  // A card asked again under the same `waitId` (its stale invocation
  // withdrawn) is the same card, and the person keeps the computer: `request`
  // registers it right after withdrawing the old one, so it waits again by the
  // time this runs.
  deps.handoffs.onSettled((prompt) => {
    queueMicrotask(() => {
      if (deps.handoffs.get(prompt.botId, prompt.waitId) === undefined) release(prompt.botId, prompt.waitId);
    });
  });

  const run = async (botId: string, command: string, what: string) => {
    const result = await deps.host.runGuestCommand(botId, command, {
      timeoutMs: GUEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: GUEST_COMMAND_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) throw new Error(`The Bot's computer couldn't ${what} (exit ${result.exitCode ?? "none"}).`);
  };

  return async (botId, waitId, url) => {
    if (!deps.enabled() || deps.handoffs.get(botId, waitId) === undefined) return false;
    try {
      if ((await deps.host.computer(botId)) === undefined) return false;
      await deps.host.ensureRunning(botId, { reason: "viewer" });
    } catch (error) {
      deps.onError?.(error);
      return false;
    }
    // Before anything shows on the screen. A person already in control keeps it as they took it.
    if (deps.control.controller(botId) !== "person") {
      deps.control.takeOver(botId, "sign_in");
      held.add(heldKey(botId, waitId));
    }
    try {
      const guestOs = deps.guestOs ?? botComputerGuestOs();
      await run(botId, guestDriverSuspendScript(guestOs), "stop its screen helper");
      if (guestOs === "linux") {
        await run(botId, botComputerStopShellUserScript(), "stop its background processes");
      }
      if (url !== undefined) await run(botId, botComputerSignInOpenScript(url, guestOs), "open the page");
    } catch (error) {
      release(botId, waitId);
      deps.onError?.(error);
      return false;
    }
    // The card may have settled while the page opened: nothing would give the computer back then.
    if (deps.handoffs.get(botId, waitId) === undefined) release(botId, waitId);
    return true;
  };
}
