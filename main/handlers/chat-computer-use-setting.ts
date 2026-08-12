import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import type { Chat, ComputerUseStatus } from "../services/types.js";

export interface ComputerUseSettingChangeDependencies {
  begin(chatId: string): (() => void) | null;
  status(signal: AbortSignal): Promise<ComputerUseStatus>;
  persist(chatId: string, enabled: boolean, isCurrent: () => boolean): Promise<Chat>;
  revokeLive(chatId: string): void;
}

/**
 * Apply one per-chat Computer Use intent. Disable is an authority revocation:
 * it closes the exact Live session synchronously, before any persistence work
 * can yield, and remains revoked even when the durable setting write fails.
 */
export async function applyComputerUseSettingChange(
  owner: RendererDocumentOwner,
  chatId: string,
  enabled: boolean,
  dependencies: ComputerUseSettingChangeDependencies,
): Promise<Chat> {
  if (!enabled) dependencies.revokeLive(chatId);

  const release = dependencies.begin(chatId);
  if (!release) {
    throw new Error("Finish or stop the current response before changing Computer Use.");
  }
  const controller = new AbortController();
  const removeInvalidation = owner.onInvalidated(() =>
    controller.abort(new Error("The renderer document is no longer active.")),
  );
  try {
    if (enabled) {
      const status = await dependencies.status(controller.signal);
      if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
      if (!status.ready) throw new Error(status.detail);
    }
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    return await dependencies.persist(chatId, enabled, () => !owner.isDestroyed());
  } finally {
    removeInvalidation();
    release();
  }
}
