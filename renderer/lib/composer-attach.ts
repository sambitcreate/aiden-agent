interface ComposerImageReceiver {
  chatId: string;
  available: () => boolean;
  /** Feeds files through the composer's clipboard-image path, so its limits and model checks apply. */
  receive: (files: File[]) => void;
}

/**
 * Lets another panel (the Simulator tab's Screenshot to chat) hand images to
 * the mounted composer of one chat. Delivery needs exactly one available
 * composer for that chat, so hidden or duplicate composers never race.
 */
export class ComposerImageAttachRegistry {
  private readonly receivers = new Map<symbol, ComposerImageReceiver>();

  register(receiver: ComposerImageReceiver): () => void {
    const token = Symbol("composer-image-attach");
    this.receivers.set(token, receiver);
    return () => {
      this.receivers.delete(token);
    };
  }

  /** Returns false when no single composer for this chat can take the files right now. */
  deliver(chatId: string, files: File[]): boolean {
    const eligible = [...this.receivers.values()].filter(
      (receiver) => receiver.chatId === chatId && receiver.available(),
    );
    if (eligible.length !== 1 || files.length === 0) return false;
    eligible[0]!.receive(files);
    return true;
  }
}

export const composerImageAttach = new ComposerImageAttachRegistry();
export const COMPOSER_IMAGE_UNAVAILABLE =
  "The chat composer is not available. Return to this chat's composer, then try again.";
