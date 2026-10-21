// The Bot's `computer_shell` tool (plan §8.6): a shell command inside its own
// computer, over SSH as the guest user, never on the person's Mac.
//
// - Bounded: 120 seconds (the guest's own alarm, plus a local bound for a dead
//   connection) and 64 KiB of output, shown like `run_command`'s output.
// - Control: while the person holds the computer the command waits for Give
//   back, and Take over ends a running command's SSH connection, as it stops
//   any computer action. Without a terminal the guest side is not signalled,
//   so the command itself can keep running until it ends or its alarm fires;
//   the result says so.
// - The guest user is the computer's administrator, but sudo needs the guest
//   password, which only Aiden holds and never shows the model.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { boundedToolOutput } from "../tool-output-context.js";
import { BOT_COMPUTER_UNATTENDED_WAIT_MS, botComputerUnattendedGaveUp, waitForBotWithin } from "./control.js";
import {
  BOT_COMPUTER_SHELL_TOOL_NAME,
  BotComputerError,
  BotComputerTakenOverError,
  type BotComputerControl,
  type BotComputerGuestCommandResult,
  type BotComputerHost,
  type BotComputerStartReason,
} from "./types.js";

export const BOT_COMPUTER_SHELL_TIMEOUT_MS = 120_000;
export const BOT_COMPUTER_SHELL_OUTPUT_BYTES = 64 * 1024;
/** What the model sees of the output, as for `run_command`. */
export const BOT_COMPUTER_SHELL_RESULT_CHARS = 20_000;
export const BOT_COMPUTER_SHELL_COMMAND_MAX_CHARS = 8_000;

export const BotComputerShellParameters = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: BOT_COMPUTER_SHELL_COMMAND_MAX_CHARS,
      description: "The command to run in your computer, with /bin/sh as its user, in its home folder.",
    }),
    description: Type.Optional(
      Type.String({
        maxLength: 200,
        description: 'A short present-tense description of what the command does, in 5-10 words, e.g. "Install the project\'s dependencies".',
      }),
    ),
  },
  { additionalProperties: false },
);

export const BOT_COMPUTER_SHELL_TOOL_DESCRIPTION =
  "Run a shell command inside your own computer (the macOS virtual machine), never on the person's Mac. " +
  "Use it to install and run tools there. Runs as the computer's user, without the password sudo asks for, for up to 120 seconds, with up to 64 KiB of output. " +
  "~/Shared (/Volumes/My Shared Files) is your Computer folder, shared with the person's Files panel.";

export interface BotComputerShellDependencies {
  host: Pick<BotComputerHost, "ensureRunning" | "runGuestCommand" | "touch">;
  control: Pick<BotComputerControl, "controller" | "run" | "waitForBot">;
  botName(botId: string): Promise<string>;
  /** How long an unattended turn waits for Give back (default `BOT_COMPUTER_UNATTENDED_WAIT_MS`). */
  unattendedWaitMs?: number;
}

export interface BotComputerShellTurn {
  routine: boolean;
  /** Nobody can answer on this turn (a routine or Telegram run). Defaults to `routine`. */
  unattended?: boolean;
}

function textResult(value: string, isError = false): AgentToolResult<null> {
  return { content: [{ type: "text", text: value }], details: null, ...(isError ? { isError: true } : {}) };
}

/** The guest command's result as the model reads it, `run_command`'s way. */
export async function formatBotComputerShellResult(result: BotComputerGuestCommandResult): Promise<AgentToolResult<null>> {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const cut = result.truncated ? `\n[Output cut at ${BOT_COMPUTER_SHELL_OUTPUT_BYTES / 1024} KiB.]` : "";
  if (result.exitCode === 0 && !result.timedOut) {
    return textResult(await boundedToolOutput(`${combined || "[no output]"}${cut}`, BOT_COMPUTER_SHELL_RESULT_CHARS));
  }
  const reason = result.timedOut
    ? `Command timed out after ${BOT_COMPUTER_SHELL_TIMEOUT_MS / 1000} seconds.`
    : `Command exited with error (code ${result.exitCode ?? "?"}).`;
  return textResult(await boundedToolOutput(`${reason}${combined ? `\n${combined}` : ""}${cut}`, BOT_COMPUTER_SHELL_RESULT_CHARS), true);
}

export function createBotComputerShellTool(
  botId: string,
  deps: BotComputerShellDependencies,
  turn: BotComputerShellTurn,
): AgentTool<typeof BotComputerShellParameters, null> {
  const reason: BotComputerStartReason = turn.routine ? "routine" : "tool";
  // Nobody can give the computer back on behalf of a routine or Telegram run: its wait is bounded.
  const giveBackWaitMs = (turn.unattended ?? turn.routine) ? (deps.unattendedWaitMs ?? BOT_COMPUTER_UNATTENDED_WAIT_MS) : undefined;
  return {
    name: BOT_COMPUTER_SHELL_TOOL_NAME,
    label: "Computer shell",
    description: BOT_COMPUTER_SHELL_TOOL_DESCRIPTION,
    parameters: BotComputerShellParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      const command = typeof params?.command === "string" ? params.command : "";
      if (!command.trim()) return textResult("computer_shell needs a command.", true);
      const owner = (await deps.botName(botId).catch(() => undefined)) || "The Bot";
      const progress = (line: string) => onUpdate?.({ content: [{ type: "text", text: line }], details: null });
      /** False when an unattended turn stopped waiting; the person still has the computer. */
      const waitForGiveBack = async (): Promise<boolean> => {
        progress(`Waiting for the person to give ${owner}'s computer back.`);
        return waitForBotWithin(deps.control, botId, signal, giveBackWaitMs);
      };
      try {
        if (deps.control.controller(botId) === "person" && !(await waitForGiveBack())) {
          return textResult(botComputerUnattendedGaveUp(`${owner}'s`), true);
        }
        await deps.host.ensureRunning(botId, { reason, signal, onProgress: progress });
        const result = await deps.control.run(botId, signal, (actionSignal) =>
          deps.host.runGuestCommand(botId, command, {
            timeoutMs: BOT_COMPUTER_SHELL_TIMEOUT_MS,
            maxOutputBytes: BOT_COMPUTER_SHELL_OUTPUT_BYTES,
            signal: actionSignal,
          }),
        );
        return await formatBotComputerShellResult(result);
      } catch (error) {
        if (error instanceof BotComputerTakenOverError) {
          const back = await waitForGiveBack();
          const stopped =
            "The person took over the computer, so Aiden stopped waiting for the command. It may have partly run, or still be running in the computer: check before running it again.";
          return textResult(back ? stopped : `${stopped} ${botComputerUnattendedGaveUp(`${owner}'s`)}`, true);
        }
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
        if (error instanceof BotComputerError) return textResult(error.message, true);
        return textResult(`Aiden couldn't run the command in ${owner}'s computer. Try again.`, true);
      } finally {
        deps.host.touch(botId);
      }
    },
  };
}
