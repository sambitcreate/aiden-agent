// Aiden's "Enter design mode?" card (design mode P3d). Main sends a request
// to the window that owns the reply; this card shows it above the composer
// with Enter design mode and Not now. Enter turns design mode on in main, so
// Aiden's next step already has the canvas.

import { PencilRuler } from "lucide-react";
import * as React from "react";
import { Button, Callout, toast } from "../components/ui";
import { designCanvasApi } from "../lib/ipc";
import { forgetPendingDesignEntry, notePendingDesignEntry } from "../lib/design-mode";

export type DesignModeConsentRequest = { requestId: string; chatId: string; reason: string };

const ANSWER_FAILED = "Design mode could not be turned on.";

/**
 * Cards waiting in this window, by chat, kept for the whole app so switching
 * chats and back still shows the card. One per chat; main closes the older one.
 */
const waiting = new Map<string, DesignModeConsentRequest>();
const listeners = new Set<() => void>();
let installed = false;

function changed() {
  for (const listener of listeners) listener();
}

function install() {
  if (installed) return;
  installed = true;
  designCanvasApi.onDesignModeConsent((request) => {
    if (typeof request?.requestId !== "string" || typeof request.chatId !== "string") return;
    waiting.set(request.chatId, {
      requestId: request.requestId,
      chatId: request.chatId,
      reason: typeof request.reason === "string" ? request.reason : "",
    });
    changed();
  });
  designCanvasApi.onDesignModeConsentClosed((closed) => {
    for (const [chatId, request] of waiting) {
      if (request.requestId === closed?.requestId) waiting.delete(chatId);
    }
    changed();
  });
}

/** For tests: forget cards and listeners between cases. */
export function resetDesignModeConsentForTests(): void {
  waiting.clear();
  listeners.clear();
  installed = false;
}

/** The card waiting for this chat, if Aiden asked. */
export function useDesignModeConsent(chatId: string | undefined): DesignModeConsentRequest | null {
  React.useEffect(() => install(), []);
  const request = React.useSyncExternalStore(
    React.useCallback((listener: () => void) => {
      install();
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, []),
    () => (chatId ? (waiting.get(chatId) ?? null) : null),
  );
  return request;
}

export function DesignModeConsentCard({ request }: { request: DesignModeConsentRequest }) {
  const [answering, setAnswering] = React.useState<"enter" | "decline" | null>(null);

  const answer = async (choice: "enter" | "decline") => {
    if (answering) return;
    setAnswering(choice);
    // The person chose to enter, so the layout makes room the way the Design toggle does.
    if (choice === "enter") notePendingDesignEntry(request.chatId, "card");
    try {
      const accepted = await designCanvasApi.answerDesignModeConsent(request.requestId, choice);
      if (!accepted) {
        if (choice === "enter") forgetPendingDesignEntry(request.chatId);
        toast.info("Aiden is no longer waiting for this answer.");
      }
    } catch (error) {
      if (choice === "enter") forgetPendingDesignEntry(request.chatId);
      toast.error(error instanceof Error && error.message ? error.message : ANSWER_FAILED);
    } finally {
      // Main closes the card either way; drop it here too in case the window missed that.
      if (waiting.get(request.chatId)?.requestId === request.requestId) {
        waiting.delete(request.chatId);
        changed();
      }
    }
  };

  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <Callout role="group" aria-label="Aiden asks to open design mode">
        <div className="flex items-start gap-2">
          <PencilRuler className="mt-0.5 size-3.5 shrink-0 text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-small font-medium text-primary">Open design mode?</p>
            {request.reason ? <p className="mt-0.5 text-small text-secondary">{request.reason}</p> : null}
            <p className="mt-0.5 text-small text-tertiary">A design canvas opens beside this chat. You can leave it any time.</p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          <Button
            variant="transparent"
            size="small"
            disabled={answering !== null}
            onClick={() => void answer("decline")}
          >
            Not now
          </Button>
          <Button
            variant="accent"
            size="small"
            disabled={answering !== null}
            onClick={() => void answer("enter")}
          >
            {answering === "enter" ? "Opening…" : "Enter design mode"}
          </Button>
        </div>
      </Callout>
    </div>
  );
}
