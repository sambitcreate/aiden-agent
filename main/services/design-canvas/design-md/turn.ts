/**
 * The per-turn DESIGN.md glue for a design-mode turn (spec §6.9, R5–R7),
 * behind the live flag. llm-client builds one per turn that has the canvas
 * tools and keeps only the calls: the `design_system` tool, the sentence the
 * canvas status note carries, the `canvas_read` line and the turn's settle.
 *
 * The sentence holds only checked, quoted paths, counts and fixed words (see
 * `designMdStatusSentence`), so the system prompt and tools never change with
 * the file and an unchanged file adds no new note. Any failure to read, or a
 * read over the 3 s budget, leaves the sentence empty and is logged: a broken
 * or slow DESIGN.md never breaks or holds up the note.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { readCanvasConfig, type CanvasConfig } from "../canvas-config.js";
import { DESIGN_MD_BULLET_PREFIX, LIMITED_APP_PROMPT_MARKER, LIVE_APP_PROMPT_MARKER } from "../canvas-tools.js";
import { locateDesignMd, type DesignAppRoots } from "./locate.js";
import type { DesignMdOffers } from "./offers.js";
import { designMdStatusSentence } from "./status.js";
import { createDesignSystemTool, type DesignSystemToolDeps } from "./tool.js";

/** Transcript section carrying the design-mode prompt once design mode is entered mid-reply. */
export const DESIGN_MODE_SECTION = "design-mode";

export type DesignMdTurnDeps = {
  workspaceRoot: string;
  reader: DesignSystemToolDeps["reader"];
  offers: Pick<DesignMdOffers, "offerFor" | "settle">;
  appRoots: DesignAppRoots;
  config?: () => Promise<CanvasConfig | null>;
  /** The canvas tools' own check: design mode on, the same folder, access kept. */
  stillAvailable?(): Promise<boolean>;
  /** The chat could write the draft: not a Bot, assistant, windowless or read-only turn. */
  offerable: boolean;
  /** ask_user_question is offered this turn, so the offer's question can be asked. */
  askOffered: boolean;
  report?: (event: "design_md_drafted", props: { source: "app" }) => void;
  log?: (message: string, error?: unknown) => void;
  draftFor?: DesignSystemToolDeps["draftFor"];
  /** How long the sentence may take before the note goes without it; 3 s by default. */
  budgetMs?: number;
};

/** The status note waits this long for the DESIGN.md sentence, then goes without it. */
export const DESIGN_MD_SENTENCE_BUDGET_MS = 3_000;

export type DesignMdTurn = {
  tool: AgentTool;
  /** The status note's DESIGN.md sentence, with the draft offer when one is due; "" on failure. */
  statusSentence(signal?: AbortSignal): Promise<string>;
  /** The same sentence without the offer, for `canvas_read`; "" on failure. */
  canvasReadLine(signal?: AbortSignal): Promise<string>;
  /** Settles the offers this turn made (only those) and reports drafts the turn wrote (R7). */
  settle(delivered: boolean): Promise<void>;
};

export function createDesignMdTurn(deps: DesignMdTurnDeps): DesignMdTurn {
  const config = deps.config ?? (() => readCanvasConfig(deps.workspaceRoot));
  const drafted = new Set<string>();
  const reported = new Set<string>();

  const tool = createDesignSystemTool({
    workspaceRoot: deps.workspaceRoot,
    reader: deps.reader,
    appRoots: deps.appRoots,
    config,
    ...(deps.stillAvailable ? { stillAvailable: () => deps.stillAvailable!() } : {}),
    ...(deps.draftFor ? { draftFor: deps.draftFor } : {}),
    // The tool drafts only for an app with no DESIGN.md, so the target was absent.
    onDraft: (target) => drafted.add(target),
  });

  /** Keys of the offers this turn's sentences carried, settled by this turn alone. */
  const offered: string[] = [];
  const budgetMs = deps.budgetMs ?? DESIGN_MD_SENTENCE_BUDGET_MS;

  const compose = async (withOffer: boolean, signal: AbortSignal): Promise<{ text: string; key?: string }> => {
    const current = await config();
    const { roots, more } = await deps.appRoots(deps.workspaceRoot, { signal, config: current });
    // Each root is read at once; the linter's own pool still runs at most two.
    const entries = await Promise.all(
      roots.map(async (appRoot) => {
        const located = await locateDesignMd(deps.workspaceRoot, appRoot, current, { signal });
        return { appRoot, state: await deps.reader.read(deps.workspaceRoot, located, { signal }) };
      }),
    );
    let offer: { sentence: string; key: string } | null = null;
    if (withOffer && deps.offerable && deps.askOffered) {
      // The first app without a DESIGN.md that hasn't had its offer yet.
      for (const entry of entries) {
        if (entry.state.status !== "missing") continue;
        offer = await deps.offers.offerFor(deps.workspaceRoot, entry.appRoot);
        if (offer) break;
      }
    }
    const text = designMdStatusSentence(entries, { more, ...(offer ? { offer: offer.sentence } : {}) });
    return offer ? { text, key: offer.key } : { text };
  };

  const sentence = async (withOffer: boolean, signal?: AbortSignal): Promise<string> => {
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    let timer: NodeJS.Timeout | undefined;
    let overBudget = false;
    const work = compose(withOffer, controller.signal);
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        overBudget = true;
        controller.abort();
        resolve(null);
      }, budgetMs);
    });
    try {
      const result = await Promise.race([work, budget]);
      if (result === null) {
        // An offer claimed after the budget ran out was never shown; release it.
        void work.then(
          (late) => (late.key ? deps.offers.settle(late.key, false) : undefined),
          () => undefined,
        );
        deps.log?.("The app's DESIGN.md took too long for the canvas note; it's left out this time.");
        return "";
      }
      if (result.key) offered.push(result.key);
      return result.text;
    } catch (error) {
      if (!signal?.aborted && !overBudget) deps.log?.("Could not read the app's DESIGN.md for the canvas note.", error);
      return "";
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  };

  return {
    tool,
    statusSentence: (signal) => sentence(true, signal),
    canvasReadLine: (signal) => sentence(false, signal),
    settle: async (delivered) => {
      const targets = [...drafted];
      drafted.clear();
      if (delivered) {
        for (const target of targets) {
          if (reported.has(target)) continue;
          const file = path.join(path.resolve(deps.workspaceRoot), ...target.split("/"));
          const written = await lstat(file).then((info) => info.isFile(), () => false);
          if (!written) continue;
          reported.add(target);
          deps.report?.("design_md_drafted", { source: "app" });
        }
      }
      const keys = offered.splice(0);
      for (const key of keys) await deps.offers.settle(key, delivered);
    },
  };
}

/**
 * The design-mode prompt as a transcript section, for a chat that entered
 * design mode mid-reply. Appended when absent. With the live flag on it's
 * appended again when the latest one differs (the flag flipped since the
 * chat's last turn); with it off, any copy already there is kept, exactly as
 * before the flag. Otherwise the same array, so the prompt cache holds. Pure.
 */
export function withDesignModeSection(
  messages: AgentMessage[],
  text: string,
  now: number,
  options: { live: boolean },
): AgentMessage[] {
  let latest: unknown;
  for (const message of messages) {
    const sections = (message as { role?: unknown; sections?: Record<string, unknown> }).sections;
    if (message.role === ("system" as AgentMessage["role"]) && sections && typeof sections[DESIGN_MODE_SECTION] === "string") {
      latest = sections[DESIGN_MODE_SECTION];
    }
  }
  // Flag off (or design_system excluded): keep any copy already there, as
  // before the flag, unless it carries the DESIGN.md bullet, which names a
  // tool this turn doesn't have.
  // 3b (S86): nor the live section, which names design_app. 3d (S114): nor the
  // limited section, which a flag-off turn swaps back to v1's.
  const flagOnSection =
    typeof latest === "string" &&
    (latest.includes(DESIGN_MD_BULLET_PREFIX) || latest.includes(LIVE_APP_PROMPT_MARKER) || latest.includes(LIMITED_APP_PROMPT_MARKER));
  if (latest === text || (!options.live && latest !== undefined && !flagOnSection)) return messages;
  return [...messages, { role: "system", content: "", sections: { [DESIGN_MODE_SECTION]: text }, timestamp: now } as unknown as AgentMessage];
}
