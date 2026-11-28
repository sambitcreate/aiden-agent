/**
 * How a design-mode turn wires DESIGN.md in (spec §6.9, R5–R7): which chats
 * may get a draft offer, when the per-turn DESIGN.md glue exists, and the
 * sentence the canvas status note carries and settles. llm-client calls these;
 * they hold the branches so a test fails if the wiring is lost.
 */
import type { DesignMdTurn, DesignMdTurnDeps } from "./turn.js";

/** A chat that could write the offered files: not a Bot, the assistant, windowless, read-only or without write_file. */
export function designOfferable(chat: {
  bot: boolean;
  assistantMode: boolean;
  windowless: boolean;
  permission: string;
  writeFileExcluded: boolean;
}): boolean {
  return (
    !chat.bot &&
    !chat.assistantMode &&
    !chat.windowless &&
    chat.permission !== "none" &&
    chat.permission !== "read-only" &&
    !chat.writeFileExcluded
  );
}

/**
 * Whether this turn gets DESIGN.md at all: the live flag is on and the turn
 * doesn't exclude `design_system`. When it's false there is no tool, no
 * status sentence or draft offer, and the prompt section is the flag-off one,
 * so Aiden is never told to call a tool it doesn't have.
 */
export function designMdLive(live: boolean, excludeToolNames: ReadonlySet<string> | undefined): boolean {
  return live && !excludeToolNames?.has("design_system");
}

/** The DESIGN.md turn's options, only with the live flag on. */
export function designMdTurnDeps(input: {
  live: boolean;
  workspaceRoot: string;
  offerable: boolean;
  askOffered: boolean;
  stillAvailable: () => Promise<boolean>;
  services: Pick<DesignMdTurnDeps, "reader" | "offers" | "appRoots" | "report" | "log">;
}): DesignMdTurnDeps | undefined {
  if (!input.live) return undefined;
  return {
    ...input.services,
    workspaceRoot: input.workspaceRoot,
    stillAvailable: input.stillAvailable,
    offerable: input.offerable,
    askOffered: input.askOffered,
  };
}

/**
 * The sentence the canvas status note carries, and its settle. With the live
 * flag on, it's the DESIGN.md sentence (with its draft offer); with it off,
 * the plain line (3d, S114: v1's tokens offer is gone in both).
 */
export function createDesignNoteOffers(input: {
  live: boolean;
  mdTurn: Pick<DesignMdTurn, "statusSentence" | "settle"> | undefined;
  signal: AbortSignal;
  log: (message: string, error?: unknown) => void;
}): { statusLine(line: string): Promise<string>; settle(delivered: boolean): void } {
  return {
    statusLine: async (line) => {
      if (!input.live || !input.mdTurn) return line;
      const sentence = await input.mdTurn.statusSentence(input.signal);
      return sentence ? `${line} ${sentence}` : line;
    },
    settle: (delivered) => {
      input.mdTurn?.settle(delivered).catch((error: unknown) => input.log("Could not settle the DESIGN.md offer.", error));
    },
  };
}
