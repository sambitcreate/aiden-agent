// A sign-in card's Open on the Bot's own computer (plan §8.6, `target:
// "computer"`): the `botComputer` opener of `bot-handoff-open.ts`.
//
// - The person takes the computer over first (`takeOver(botId, "sign_in")`).
//   That aborts the Bot's in-flight action, and every later `computer` and
//   `computer_shell` call waits for Give back, so the model sees nothing of
//   the screen while the person signs in, and never the password.
// - The guest driver is stopped before the page opens: its LaunchAgent's
//   "enabled" file goes and every process signed as `cua-driver` is killed,
//   so nothing the Bot left running can read the screen through it. The
//   driver lane's bridge starts it again on the Bot's next element step.
// - Then the site opens in Safari in the computer, and the panel's Computer
//   tab comes forward in the window whose Open was pressed.
// - When the card settles or is withdrawn, the computer is given back, unless
//   the person already gave it back or took it again some other way.
// - Only for a Bot with a computer while Bot computers are on. Anything that
//   fails gives the computer back and opens nothing.
//
// Holds live in memory: an app restart stops the computer, so a hold can't
// outlive it.

import type { BotComputerControl, BotComputerHost, BotComputerTakeOverSource } from "../bot-computers/types.js";
import { guestDriverSuspendScript } from "../bot-computers/guest-driver-install.js";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import type { BotHandoffs } from "./bot-handoffs.js";

/** Safari's bundle id: the sign-in page opens there, whatever the default browser is. */
export const BOT_COMPUTER_SIGN_IN_BROWSER = "com.apple.Safari";

const GUEST_COMMAND_TIMEOUT_MS = 30_000;
const GUEST_COMMAND_OUTPUT_BYTES = 4_096;

/** The guest command that opens the sign-in page; `url` is a checked https origin. */
export function botComputerSignInOpenScript(url: string): string {
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
  /** Why an Open opened nothing. */
  onError?(error: unknown): void;
}

/** Open `url` on the Bot's computer for the card `waitId`, with the person in control. False when nothing opened. */
export type BotComputerHandoffOpener = (botId: string, waitId: string, url: string) => Promise<boolean>;

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

  deps.handoffs.onSettled((prompt) => release(prompt.botId, prompt.waitId));

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
      await run(botId, guestDriverSuspendScript(), "stop its screen helper");
      await run(botId, botComputerSignInOpenScript(url), "open the sign-in page");
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
