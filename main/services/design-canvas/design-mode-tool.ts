// Aiden's `design_mode` tool (design mode P3d). Entering asks the person on a
// card in the chat (Enter design mode / Not now); leaving needs no consent.
// It follows `aiden_open`: main sends the request to the window that owns the
// turn, that window answers, and main resolves the result.

import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";

export const DESIGN_MODE_TOOL_NAME = "design_mode";
/** The reason shown on the consent card. */
export const DESIGN_MODE_REASON_CHARS = 200;
/** A card nobody answers stops waiting after this long. */
export const DESIGN_MODE_CONSENT_TIMEOUT_MS = 10 * 60_000;

/** `designCanvas:consent`, to the turn's window. */
export type DesignModeConsentRequest = { requestId: string; chatId: string; reason: string };
/** `designCanvas:consentClosed`: the card is no longer waiting (answered, stopped or timed out). */
export type DesignModeConsentClosed = { requestId: string };

type ConsentResult = "entered" | "declined" | "unavailable";
type Pending = { chatId: string; owner: ChatGenerationOwner; finish(result: ConsentResult): void };

/** Pending consent cards. Only the window that received a card may answer it. */
export class DesignModeConsent {
  private pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = DESIGN_MODE_CONSENT_TIMEOUT_MS) {}

  request(input: { chatId: string; reason: string; owner?: ChatGenerationOwner; signal?: AbortSignal }): Promise<ConsentResult> {
    const { owner, signal } = input;
    if (!owner || owner.kind === "remote" || owner.id === 0 || owner.isDestroyed() || signal?.aborted) {
      return Promise.resolve("unavailable");
    }
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
    const request = this.pending.get(requestId);
    if (
      !request ||
      request.owner.id !== owner.id ||
      request.owner.documentId !== owner.documentId ||
      request.owner.isDestroyed() ||
      owner.isDestroyed()
    ) {
      return false;
    }
    if (answer === "decline") {
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
    request.finish("entered");
    reportAnalyticsEvent("design_mode_entered", { source: "aiden" });
    return true;
  }
}

export type DesignModeToolDeps = {
  /** Design mode is on in this chat right now. */
  isOn(): Promise<boolean>;
  requestEnter(reason: string, signal?: AbortSignal): Promise<ConsentResult>;
  exit(): Promise<void>;
};

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: null });

export function createDesignModeTool(deps: DesignModeToolDeps): AgentTool {
  return declarePiRuntimeReplay(
    {
      name: DESIGN_MODE_TOOL_NAME,
      label: "Design mode",
      description:
        "Ask to open design mode, which puts an infinite design canvas beside this chat, or leave it. Ask to enter when the person wants pages or screens to look at or compare side by side; they choose on a card. Leave when the design work is done.",
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
            next: "The canvas is open beside the chat. canvas_read, canvas_place_frame, canvas_update_frame, canvas_remove_frame and canvas_focus work from your next step; load the aiden-design skill first.",
          });
        }
        return result({
          status: answer,
          ...(answer === "declined" ? { next: "The person chose Not now. Carry on in the chat and do not ask again this reply." } : {}),
        });
      },
    },
    "never",
  );
}
