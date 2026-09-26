import type { BrowserAnnotation } from "../shared/browser";

interface BrowserAnnotationReceiver {
  workspaceId: string;
  chatId: string;
  available: () => boolean;
  receive: (annotation: BrowserAnnotation) => boolean;
}

export interface BrowserAnnotationRecipient {
  readonly workspaceId: string;
  readonly chatId: string;
  /** A single-use receipt tied to this exact mounted composer. */
  deliver: (annotation: BrowserAnnotation) => boolean;
}

/** Main validates page context; this document acknowledges the actual draft write. */
export class BrowserAnnotationDeliveryRegistry {
  private readonly receivers = new Map<symbol, BrowserAnnotationReceiver>();

  register(receiver: BrowserAnnotationReceiver): () => void {
    const token = Symbol("browser-annotation-composer");
    this.receivers.set(token, receiver);
    return () => { this.receivers.delete(token); };
  }

  capture(workspaceId: string): BrowserAnnotationRecipient | null {
    const eligible = [...this.receivers.entries()].filter(([, receiver]) => receiver.workspaceId === workspaceId && receiver.available());
    // Hidden/background composers must never race to consume the same selection.
    if (eligible.length !== 1) return null;
    const [token, receiver] = eligible[0];
    let delivered = false;
    return {
      workspaceId,
      chatId: receiver.chatId,
      deliver: (annotation) => {
        if (delivered || this.receivers.get(token) !== receiver || !receiver.available()) return false;
        const accepted = receiver.receive(annotation);
        if (accepted) delivered = true;
        return accepted;
      },
    };
  }
}

export const browserAnnotationDelivery = new BrowserAnnotationDeliveryRegistry();
export const BROWSER_ANNOTATION_UNAVAILABLE = "The chat composer is not available. Finish the current question or return to a chat, then add this annotation again. Your selection is kept here.";
