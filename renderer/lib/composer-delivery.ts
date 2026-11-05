interface ComposerReceiver<T> {
  workspaceId: string;
  chatId: string;
  available: () => boolean;
  receive: (payload: T) => boolean;
}

export interface ComposerRecipient<T> {
  readonly workspaceId: string;
  readonly chatId: string;
  /** A single-use receipt tied to this exact mounted composer. */
  deliver: (payload: T) => boolean;
}

/** Hands one payload to the single composer showing a workspace, and acknowledges the draft write. */
export class ComposerDeliveryRegistry<T> {
  private readonly receivers = new Map<symbol, ComposerReceiver<T>>();

  register(receiver: ComposerReceiver<T>): () => void {
    const token = Symbol("composer-delivery");
    this.receivers.set(token, receiver);
    return () => { this.receivers.delete(token); };
  }

  capture(workspaceId: string): ComposerRecipient<T> | null {
    const eligible = [...this.receivers.entries()].filter(([, receiver]) => receiver.workspaceId === workspaceId && receiver.available());
    // Hidden/background composers must never race to consume the same payload.
    if (eligible.length !== 1) return null;
    const [token, receiver] = eligible[0];
    let delivered = false;
    return {
      workspaceId,
      chatId: receiver.chatId,
      deliver: (payload) => {
        if (delivered || this.receivers.get(token) !== receiver || !receiver.available()) return false;
        const accepted = receiver.receive(payload);
        if (accepted) delivered = true;
        return accepted;
      },
    };
  }
}
