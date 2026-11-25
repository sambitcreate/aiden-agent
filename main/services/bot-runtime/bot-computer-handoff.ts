// A sign-in card's Open on the Bot's own Linux computer (`target: "computer"`):
// the `botComputer` opener of `bot-handoff-open.ts`.
//
// - The person takes the computer over first (`takeOver(botId, "sign_in")`).
//   That aborts the Bot's in-flight action, and every later `computer` and
//   `computer_shell` call waits for Give back, so no tool shows the model the
//   screen while the person signs in, and never the password.
// - Before the page opens, Aiden stops the guest driver (`systemd --user`
//   `cua-driver.service`) and terminates every process owned by the separate
//   Bot shell user (`aiden-bot`, decision 4a) so no background program started
//   by the Bot runs while the person signs in.
// - Then the site opens in Chromium in the Linux computer, and the panel's
//   Computer tab comes forward in the window whose Open was pressed.
// - When the card settles or is withdrawn, the computer is given back, unless
//   the person already gave it back or took it again some other way. A card
//   asked again under the same wait id keeps it with the person.
// - Only for a Bot with a computer while Bot computers are on. Anything that
//   fails gives the computer back and opens nothing.

import {
  BOT_COMPUTER_LINUX_SHELL_USER,
  type BotComputerControl,
  type BotComputerHost,
  type BotComputerTakeOverSource,
} from "../bot-computers/types.js";
import { guestDriverSuspendScript } from "../bot-computers/guest-driver-install.js";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import type { BotHandoffs } from "./bot-handoffs.js";

/** Browser binary on Linux Bot computers. */
export const BOT_COMPUTER_SIGN_IN_BROWSER = "chromium";

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

/** The guest command that opens the sign-in page in Chromium; `url` is a checked https origin. */
export function botComputerSignInOpenScript(url: string): string {
  return [
    `b=$(command -v ${BOT_COMPUTER_SIGN_IN_BROWSER} || command -v chromium-browser) || exit 127`,
    `DISPLAY=:0 nohup "$b" --new-window ${quoteRemoteArg(url)} </dev/null >/dev/null 2>&1 &`,
  ].join("\n");
}

export interface BotComputerHandoffDeps {
  host: Pick<BotComputerHost, "computer" | "ensureRunning" | "runGuestCommand">;
  control: Pick<BotComputerControl, "controller" | "takeOver" | "giveBack"> & {
    takenOverBy(botId: string): BotComputerTakeOverSource | undefined;
    controllerForScope?(scope: string): "bot" | "person";
    takenOverByScope?(scope: string): BotComputerTakeOverSource | undefined;
    giveBackScope?(scope: string): void;
  };
  handoffs: Pick<BotHandoffs, "get" | "onSettled">;
  /** Bot computers are on (the platform flag). */
  enabled(): boolean;
  /** Why an Open opened nothing. */
  onError?(error: unknown): void;
}

/**
 * Hand the Bot's computer to the person for the card `waitId`, opening `url`
 * in Chromium there when given (a sign-in always gives one; an action may not).
 * False when nothing opened.
 */
export type BotComputerHandoffOpener = (botId: string, waitId: string, url: string | undefined) => Promise<boolean>;

function heldKey(botId: string, waitId: string): string {
  return `${botId}\u0000${waitId}`;
}

export function createBotComputerHandoffOpener(deps: BotComputerHandoffDeps): BotComputerHandoffOpener {
  /** Open sign-in cards holding each VM (`botId\0waitId` -> VM scope key). */
  const held = new Map<string, string>();

  const release = (botId: string, waitId: string): void => {
    const key = heldKey(botId, waitId);
    const scopeKey = held.get(key);
    if (scopeKey === undefined) return;
    held.delete(key);
    // Keep the shared VM with the person while another open sign-in card still holds it.
    for (const activeScope of held.values()) {
      if (activeScope === scopeKey) return;
    }
    // Release the exact VM scope captured when the card opened (even if the Bot was reassigned since).
    if (deps.control.giveBackScope && deps.control.takenOverByScope && deps.control.controllerForScope) {
      if (deps.control.controllerForScope(scopeKey) === "person" && deps.control.takenOverByScope(scopeKey) === "sign_in") {
        deps.control.giveBackScope(scopeKey);
      }
      return;
    }
    if (deps.control.controller(botId) === "person" && deps.control.takenOverBy(botId) === "sign_in") {
      deps.control.giveBack(botId);
    }
  };

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
    let scopeKey: string;
    try {
      const computer = await deps.host.computer(botId);
      if (computer === undefined) return false;
      scopeKey = computer.computerId ?? computer.vmName ?? botId;
      await deps.host.ensureRunning(botId, { reason: "viewer" });
    } catch (error) {
      deps.onError?.(error);
      return false;
    }
    if (deps.control.controller(botId) !== "person") {
      deps.control.takeOver(botId, "sign_in");
      held.set(heldKey(botId, waitId), scopeKey);
    } else if (deps.control.takenOverBy(botId) === "sign_in") {
      // Another sign-in card already holds this shared VM; track this card too so
      // settling the first card never returns the VM while the person finishes this one.
      held.set(heldKey(botId, waitId), scopeKey);
    }
    try {
      await run(botId, guestDriverSuspendScript(), "stop its screen helper");
      await run(botId, botComputerStopShellUserScript(), "stop its background processes");
      if (url !== undefined) await run(botId, botComputerSignInOpenScript(url), "open the page");
    } catch (error) {
      release(botId, waitId);
      deps.onError?.(error);
      return false;
    }
    if (deps.handoffs.get(botId, waitId) === undefined) release(botId, waitId);
    return true;
  };
}
