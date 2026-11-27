// Aiden's `design_mode` tool (design mode P3d). Entering asks the person on a
// card in the chat (Enter design mode / Not now); leaving needs no consent.
// It follows `aiden_open`: main sends the request to the window that owns the
// turn, that window answers, and main resolves the result.

import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import { ownedPendingRequest, type ChatGenerationOwner } from "../chat-generation-owner.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { declareOnDemandSummary } from "../on-demand-tools.js";

export const DESIGN_MODE_TOOL_NAME = "design_mode";
/** The reason shown on the consent card. */
export const DESIGN_MODE_REASON_CHARS = 200;
/**
 * A card nobody answers stops waiting after this long, so a reply is never
 * held for long by a card the person walked away from; Aiden then carries on
 * in the chat.
 */
export const DESIGN_MODE_CONSENT_TIMEOUT_MS = 2 * 60_000;
/** Chats whose "Not now" is remembered; the oldest is forgotten past this. */
const DECLINED_CHATS_KEPT = 500;

/** `designCanvas:consent`, to the turn's window. */
export type DesignModeConsentRequest = { requestId: string; chatId: string; reason: string };
/** `designCanvas:consentClosed`: the card is no longer waiting (answered, stopped or timed out). */
export type DesignModeConsentClosed = { requestId: string };

type ConsentResult = "entered" | "declined" | "unavailable";
type Pending = { chatId: string; owner: ChatGenerationOwner; finish(result: ConsentResult): void };

/** Pending consent cards. Only the window that received a card may answer it. */
export class DesignModeConsent {
  private pending = new Map<string, Pending>();
  /**
   * Chats where the person chose Not now. Aiden is not asked again in them
   * until the person opens design mode themselves (`forgetDecline`). Kept in
   * memory only, so a restart of Aiden forgets them.
   */
  private declined = new Set<string>();

  constructor(private readonly timeoutMs = DESIGN_MODE_CONSENT_TIMEOUT_MS) {}

  request(input: { chatId: string; reason: string; owner?: ChatGenerationOwner; signal?: AbortSignal }): Promise<ConsentResult> {
    const { owner, signal } = input;
    if (!owner || owner.kind === "remote" || owner.id === 0 || owner.isDestroyed() || signal?.aborted) {
      return Promise.resolve("unavailable");
    }
    // Not now holds for the rest of the chat: no second card.
    if (this.declined.has(input.chatId)) return Promise.resolve("declined");
    // One card per chat: a newer request replaces an older one still showing.
    for (const entry of [...this.pending.values()]) if (entry.chatId === input.chatId) entry.finish("unavailable");
    if (this.pending.size >= 16) return Promise.resolve("unavailable");
    const requestId = randomUUID();
    return new Promise<ConsentResult>((resolve) => {
      let unsubscribe = () => {};
      const finish = (result: ConsentResult) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener("abort", abort);
        if (!owner.isDestroyed()) {
          try {
            owner.send("designCanvas:consentClosed", { requestId } satisfies DesignModeConsentClosed);
          } catch {
            // The window went away; nothing is showing the card.
          }
        }
        resolve(result);
      };
      const abort = () => finish("unavailable");
      const timeout = setTimeout(abort, this.timeoutMs);
      this.pending.set(requestId, { chatId: input.chatId, owner, finish });
      unsubscribe = owner.onInvalidated(abort);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        owner.send("designCanvas:consent", {
          requestId,
          chatId: input.chatId,
          reason: input.reason,
        } satisfies DesignModeConsentRequest);
      } catch {
        abort();
      }
    });
  }

  /**
   * The person's answer from the card. `enter` runs before the tool hears
   * "entered", so Aiden's next step already sees design mode on; if it throws,
   * the tool hears "unavailable" and the error goes back to the window.
   * False when the card is not this window's or no longer waiting.
   */
  async answer(
    requestId: unknown,
    answer: unknown,
    owner: Pick<ChatGenerationOwner, "id" | "documentId" | "isDestroyed">,
    enter: (chatId: string) => Promise<void>,
  ): Promise<boolean> {
    if (typeof requestId !== "string" || (answer !== "enter" && answer !== "decline")) return false;
    const request = ownedPendingRequest(this.pending, requestId, owner);
    if (!request) return false;
    if (answer === "decline") {
      this.declined.delete(request.chatId);
      this.declined.add(request.chatId);
      if (this.declined.size > DECLINED_CHATS_KEPT) this.declined.delete(this.declined.values().next().value!);
      request.finish("declined");
      reportAnalyticsEvent("design_mode_declined", {});
      return true;
    }
    try {
      await enter(request.chatId);
    } catch (error) {
      request.finish("unavailable");
      throw error;
    }
    this.declined.delete(request.chatId);
    request.finish("entered");
    reportAnalyticsEvent("design_mode_entered", { source: "aiden" });
    return true;
  }

  /** The person opened design mode themselves, so Aiden may ask again in this chat later. */
  forgetDecline(chatId: string): void {
    this.declined.delete(chatId);
  }
}

export type DesignModeToolDeps = {
  /** Design mode is on in this chat right now. */
  isOn(): Promise<boolean>;
  requestEnter(reason: string, signal?: AbortSignal): Promise<ConsentResult>;
  exit(): Promise<void>;
  /** The canvas tools this turn declares once design mode is on, so "entered" names only tools Aiden will have. */
  canvasToolNames: readonly string[];
};

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: null });

export function createDesignModeTool(deps: DesignModeToolDeps): AgentTool {
  return declareOnDemandSummary(
    declarePiRuntimeReplay(
    {
      name: DESIGN_MODE_TOOL_NAME,
      label: "Design mode",
      description:
        "Ask to open design mode when the person wants whole pages, app screens or several design directions to see and compare side by side. It puts an infinite design canvas beside this chat; the person chooses on a card. Leave design mode when the design work is done.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("enter"), Type.Literal("exit")]),
        reason: Type.String({
          maxLength: DESIGN_MODE_REASON_CHARS,
          description: "One short sentence the person reads on the card, such as why side by side helps.",
        }),
      }),
      execute: async (_id, args, signal) => {
        const { action, reason } = args as { action?: unknown; reason?: unknown };
        if (action !== "enter" && action !== "exit") {
          return result({ status: "error", message: 'action must be "enter" or "exit".' });
        }
        const on = await deps.isOn();
        if (action === "exit") {
          if (!on) return result({ status: "already" });
          await deps.exit();
          return result({ status: "exited" });
        }
        if (on) return result({ status: "already" });
        const text = typeof reason === "string" ? reason.trim().slice(0, DESIGN_MODE_REASON_CHARS) : "";
        if (!text) return result({ status: "error", message: "reason must say in a sentence why the canvas helps." });
        const answer = await deps.requestEnter(text, signal);
        if (answer === "entered") {
          return result({
            status: "entered",
            next:
              deps.canvasToolNames.length > 0
                ? `The canvas is open beside the chat. ${deps.canvasToolNames.join(", ")} work from your next step; load the aiden-design skill first.`
                : "The canvas is open beside the chat, but its tools are not available in this chat. Carry on in the chat.",
          });
        }
        return result({
          status: answer,
          next:
            answer === "declined"
              ? "The person chose Not now for this chat. Carry on in the chat without the canvas and do not ask again; they can open design mode themselves with the Design button."
              : "The card closed without an answer, or no window could show it. Carry on in the chat without the canvas; the person can open design mode themselves with the Design button.",
        });
      },
    },
    "never",
    ),
    "Ask to open the design canvas; use when the person wants whole pages, app screens or several directions to compare side by side.",
  );
}
