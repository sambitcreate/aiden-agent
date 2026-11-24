/**
 * How a design-mode turn wires DESIGN.md in (spec §6.9, R5–R7): which chats
 * may get a draft offer, when the per-turn DESIGN.md glue exists, and which
 * offer the canvas status note carries and settles. llm-client calls these;
 * they hold the branches so a test fails if the wiring is lost.
 */
import type { DesignSystemOffers } from "../design-system-offers.js";
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
 * The offer the canvas status note carries, and its settle. With the live
 * flag on, the DESIGN.md sentence (with its draft offer) replaces v1's tokens
 * offer; with it off, the tokens offer is made where the chat could write it.
 */
export function createDesignNoteOffers(input: {
  live: boolean;
  folderPath: string | undefined;
  offerable: boolean;
  mdTurn: Pick<DesignMdTurn, "statusSentence" | "settle"> | undefined;
  v1: Pick<DesignSystemOffers, "offerFor" | "settle">;
  signal: AbortSignal;
  log: (message: string, error?: unknown) => void;
}): { statusLine(line: string): Promise<string>; settle(delivered: boolean): void } {
  let offeredFolder: string | undefined;
  return {
    statusLine: async (line) => {
      if (input.live) {
        const sentence = input.mdTurn ? await input.mdTurn.statusSentence(input.signal) : "";
        return sentence ? `${line} ${sentence}` : line;
      }
      if (!input.folderPath || !input.offerable) return line;
      try {
        const offer = await input.v1.offerFor(input.folderPath, input.signal);
        if (offer) offeredFolder = input.folderPath;
        return offer ? `${line} ${offer}` : line;
      } catch (error) {
        if (!input.signal.aborted) input.log("Could not read the workspace's colours and fonts for a design-system offer.", error);
        return line;
      }
    },
    settle: (delivered) => {
      input.mdTurn?.settle(delivered).catch((error: unknown) => input.log("Could not settle the DESIGN.md offer.", error));
      if (offeredFolder === undefined) return;
      const folder = offeredFolder;
      offeredFolder = undefined;
      void input.v1.settle(folder, delivered);
    },
  };
}
