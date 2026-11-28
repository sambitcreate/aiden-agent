// Electron-free handler registration core for the Floating Chat Starter
// (Quick Chat) window. Kept free of Electron imports so behavioral tests can
// register and invoke every channel directly in Node.

import type { IpcMainInvokeEvent } from "electron";
import type { DesktopHandoffTicketStore } from "../services/desktop-stream-handoff.js";
import {
  parseQuickChatExpandRequest,
  parseQuickChatWindowMode,
  type QuickChatExpandResult,
  type QuickChatHandoffCompletePayload,
  type QuickChatOpenSource,
  type QuickChatWindowMode,
} from "../../renderer/shared/quick-chat.js";
import { parseSettingsSection } from "../../renderer/shared/settings-section.js";

export interface QuickChatWindowControlPort {
  isCurrentQuickChatEvent: (event: IpcMainInvokeEvent) => boolean;
  toggleQuickChat: (source: QuickChatOpenSource) => Promise<boolean>;
  hideQuickChat: () => void;
  setQuickChatMode: (mode: QuickChatWindowMode) => void;
  suppressQuickChatBlurHide: (durationMs?: number) => void;
  resetQuickChatBlurSuppression: () => void;
  notifyQuickChatHandoffComplete: (payload: QuickChatHandoffCompletePayload) => void;
}

export interface QuickChatHandlerCoreDependencies {
  isMainWindow: (event: IpcMainInvokeEvent) => boolean;
  navigateMainWindow?: (path: string) => Promise<void>;
  handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ) => void;
  windowPort: QuickChatWindowControlPort;
  tickets: DesktopHandoffTicketStore;
  resolveDocumentId: (event: IpcMainInvokeEvent) => string;
  assertChatAccess?: (event: IpcMainInvokeEvent, chatId: string) => void;
  inspectChatExpansionState?: (
    chatId: string,
  ) => Promise<{ duringStream: boolean; wasEphemeral: boolean }>;
  beginExpansionReport?: () => (info: { duringStream: boolean; wasEphemeral: boolean }) => void;
  onWarning?: (message: string, error: unknown) => void;
}

export function registerQuickChatHandlersCore(deps: QuickChatHandlerCoreDependencies): void {
  const { handle, windowPort: win, tickets, resolveDocumentId, onWarning } = deps;

  handle("quickChat:toggle", async (event) => {
    if (!deps.isMainWindow(event) && !win.isCurrentQuickChatEvent(event)) {
      throw new Error("Untrusted quick chat toggle sender.");
    }
    return await win.toggleQuickChat("command");
  });

  handle("quickChat:hide", (event) => {
    if (!win.isCurrentQuickChatEvent(event)) {
      throw new Error("Untrusted quick chat hide sender.");
    }
    win.hideQuickChat();
    return true;
  });

  handle("quickChat:setMode", (event, mode: unknown) => {
    if (!win.isCurrentQuickChatEvent(event)) {
      throw new Error("Untrusted quick chat mode sender.");
    }
    win.setQuickChatMode(parseQuickChatWindowMode(mode));
    return true;
  });

  handle("quickChat:suppressBlur", (event, durationMs: unknown) => {
    if (!win.isCurrentQuickChatEvent(event)) {
      throw new Error("Untrusted quick chat blur suppression sender.");
    }
    const parsedMs =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs
        : undefined;
    win.suppressQuickChatBlurHide(parsedMs);
    return true;
  });

  handle("quickChat:openSettings", async (event, section: unknown) => {
    if (!win.isCurrentQuickChatEvent(event)) {
      throw new Error("Untrusted quick chat settings sender.");
    }
    const parsedSection = parseSettingsSection(section);
    if (!parsedSection) {
      throw new Error("Invalid settings section.");
    }
    if (!deps.navigateMainWindow) {
      return false;
    }
    win.hideQuickChat();
    try {
      await deps.navigateMainWindow(`/quick-chat-handoff/settings/${parsedSection}`);
      return true;
    } catch (error) {
      onWarning?.("Could not open Settings from Quick Chat.", error);
      return false;
    }
  });

  handle(
    "quickChat:expandToMain",
    async (event, input: unknown): Promise<QuickChatExpandResult> => {
      if (!win.isCurrentQuickChatEvent(event)) {
        throw new Error("Untrusted quick chat expand sender.");
      }
      if (!deps.navigateMainWindow) {
        return { ok: false };
      }
      const parsed = parseQuickChatExpandRequest(input);
      if (parsed.kind === "chat") {
        deps.assertChatAccess?.(event, parsed.chatId);
      }
      // Capture analytics consent before async metadata lookups and main-window navigation.
      const reportExpanded = deps.beginExpansionReport?.();
      // Keep the floating window alive until the main window claims the ticket
      // so an in-flight stream isn't detached before ownership transfers.
      win.suppressQuickChatBlurHide(5_000);
      if (parsed.kind === "draft") {
        const ticketId = tickets.putDraft({
          workspaceId: parsed.workspaceId,
          text: parsed.text,
          attachments: parsed.attachments,
          ...(parsed.providerId ? { providerId: parsed.providerId } : {}),
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.ephemeral ? { ephemeral: true } : {}),
        });
        try {
          await deps.navigateMainWindow(`/quick-chat-handoff/draft/${ticketId}`);
          // Only clear and hide Quick Chat AFTER the main window confirms the draft opened,
          // so a blocked or failed main-window navigation never loses the user's typed text.
          win.notifyQuickChatHandoffComplete({ kind: "draft" });
          win.hideQuickChat();
          reportExpanded?.({ duringStream: false, wasEphemeral: parsed.ephemeral === true });
          return { ok: true };
        } catch (error) {
          tickets.claimDraft(ticketId);
          win.resetQuickChatBlurSuppression();
          onWarning?.("Could not expand draft into main window.", error);
          return { ok: false };
        }
      }

      const fromDocumentId = resolveDocumentId(event);
      const expansionState = deps.inspectChatExpansionState
        ? await deps.inspectChatExpansionState(parsed.chatId).catch(() => ({
            duringStream: false,
            wasEphemeral: false,
          }))
        : { duringStream: false, wasEphemeral: false };
      tickets.putChat({
        chatId: parsed.chatId,
        fromDocumentId,
        ...(parsed.draftText !== undefined ? { draftText: parsed.draftText } : {}),
        ...(parsed.draftAttachments !== undefined
          ? { draftAttachments: parsed.draftAttachments }
          : {}),
        ...(parsed.queuedMessages !== undefined ? { queuedMessages: parsed.queuedMessages } : {}),
        onClaimed: () => {
          win.notifyQuickChatHandoffComplete({ kind: "chat", chatId: parsed.chatId });
          win.hideQuickChat();
          reportExpanded?.(expansionState);
        },
      });
      try {
        await deps.navigateMainWindow(`/quick-chat-handoff/chat/${parsed.chatId}`);
        return { ok: true };
      } catch (error) {
        // Run any deferred detach callbacks instead of cancelling them, so
        // pending approvals/questions never hang if Quick Chat already detached.
        tickets.abandonChat(parsed.chatId);
        win.resetQuickChatBlurSuppression();
        onWarning?.("Could not expand chat into main window.", error);
        return { ok: false };
      }
    },
  );
}
