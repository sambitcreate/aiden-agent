// Which of the Bot's own computer tools a durable turn gets (plan §8.6), as
// `bot-tool-sources-main.ts` builds them. Electron-free, so the gating is
// tested directly:
//
// - Only where Bot computers exist (`enabled`, false on Linux and Intel Macs),
//   and only for a Bot whose access includes the computer and that has a
//   computer of its own. `botHasComputer` never builds the services where
//   they don't exist, and an unreadable state counts as no computer.
// - `computer` needs a model that takes images (the screen is vision only);
//   `computer_shell` doesn't. Both are `unsafe` to replay.
// - Routine and Telegram runs are unattended: nobody answers a card there,
//   so the guidance has no `hand_off`, and the run's two tools share one
//   bounded wait for Give back. The registry holds the attended tool set (it
//   is built without a turn), so each call asks which run it serves
//   (`BotToolCall.runRequestIds`) and runs as that run's tool.
// - The guest driver lane only for a computer whose base passed its probe.
//
// Policy (`bot-tool-policy.ts`) still decides afterwards what is offered.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import { botTurnOf } from "./bot-tool-policy.js";
import { BOT_COMPUTER_UNATTENDED_WAIT_MS } from "../bot-computers/control.js";
import { createBotComputerShellTool } from "../bot-computers/computer-shell-tool.js";
import { createBotComputerTool, type BotComputerToolDependencies, type BotComputerToolState } from "../bot-computers/computer-tool.js";
import type { BotComputerControl, BotComputerHost } from "../bot-computers/types.js";

/** The Bot computer services a turn's tools run on. */
export interface BotComputerToolServices {
  host: Pick<BotComputerHost, "computer" | "ensureRunning" | "touch" | "runGuestCommand" | "guestDriver">;
  sessions: BotComputerToolDependencies["sessions"];
  /** `onChange` keeps the tool state's capture epochs. */
  control: BotComputerToolDependencies["control"] & Pick<BotComputerControl, "onChange">;
}

/** Whether the Bot has its own computer. Never where Bot computers don't exist; an unreadable state counts as none. */
export async function botHasComputer(
  botId: string,
  services: { enabled(): boolean; computers(): Pick<BotComputerToolServices, "host"> },
): Promise<boolean> {
  if (!services.enabled()) return false;
  return (await services.computers().host.computer(botId).catch(() => undefined)) !== undefined;
}

export interface BotComputerCandidateInput {
  /** The Bot's access includes the computer capability. */
  granted: boolean;
  /** The turn's facts say the Bot has a computer of its own (see `botHasComputer`). */
  hasComputer: boolean;
  supportsImages: boolean;
  routine: boolean;
  telegram: boolean;
  /** Loaded only when the turn gets the tools. */
  computers(): BotComputerToolServices | Promise<BotComputerToolServices>;
  /** Captures and control epochs across turns (one per process). */
  state(control: BotComputerToolServices["control"]): BotComputerToolState;
  botName(botId: string): Promise<string>;
  /** How long an unattended turn waits for Give back in all (default `BOT_COMPUTER_UNATTENDED_WAIT_MS`). */
  unattendedWaitMs?: number;
}

/** The `computer` and `computer_shell` candidates for one turn, or none. */
export async function botComputerCandidates(botId: string, input: BotComputerCandidateInput): Promise<BotToolCandidate[]> {
  if (!input.granted || !input.hasComputer) return [];
  const { host, sessions, control } = await input.computers();
  const state = input.state(control);
  // The guest driver lane, only for a computer whose base passed its probe.
  const elementControl = input.supportsImages && (await host.guestDriver(botId).catch(() => undefined)) !== undefined;
  // No one answers a card on routine and Telegram runs, so there is no hand_off there, and
  // such a run waits for Give back only so long, in all, across both tools.
  const giveBackBudget = { remainingMs: input.unattendedWaitMs ?? BOT_COMPUTER_UNATTENDED_WAIT_MS };
  const turnOf = (routine: boolean, telegram: boolean) => ({
    routine,
    unattended: routine || telegram,
    ...(routine || telegram ? { giveBackBudget } : {}),
  });
  type Turn = ReturnType<typeof turnOf>;

  /** `offered` for the turn the tools were built for; each call runs as the tool of the run it serves. */
  const perRun = (offered: AgentTool, build: (turn: Turn) => AgentTool): NonNullable<BotToolCandidate["bind"]> => {
    const variants = new Map<string, AgentTool>([[`${input.routine}:${input.telegram}`, offered]]);
    return (call) => ({
      ...offered,
      async execute(toolCallId, params, signal, onUpdate) {
        const turns = ((await call.runRequestIds?.()) ?? []).map(botTurnOf);
        const routine = input.routine || turns.some((turn) => turn.routine);
        const telegram = input.telegram || turns.some((turn) => turn.telegram);
        const key = `${routine}:${telegram}`;
        let tool = variants.get(key);
        if (tool === undefined) {
          tool = build(turnOf(routine, telegram));
          variants.set(key, tool);
        }
        return tool.execute(toolCallId, params, signal, onUpdate);
      },
    });
  };

  const computerFor = (turn: Turn) =>
    createBotComputerTool(botId, { host, sessions, control, state, botName: input.botName }, { ...turn, elementControl });
  const shellFor = (turn: Turn) => createBotComputerShellTool(botId, { host, control, botName: input.botName }, turn);
  const offeredTurn = turnOf(input.routine, input.telegram);
  const candidates: BotToolCandidate[] = [];
  if (input.supportsImages) {
    const tool = computerFor(offeredTurn);
    candidates.push({ tool, replay: "unsafe", bind: perRun(tool, computerFor) });
  }
  const shell = shellFor(offeredTurn);
  candidates.push({ tool: shell, replay: "unsafe", bind: perRun(shell, shellFor) });
  return candidates;
}
