// Aiden's window-level Gemini Live control. Before setup it presents the app
// mark; after setup it becomes a stateful blue Libraries.dev orb.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCommandHandler } from "../../lib/command-system";
import type { SettingsSection } from "../../lib/settings-section";
import { AidenLiveOrb } from "./aiden-live-orb";
import {
  AssistantLiveHud,
  AssistantLiveSetupDialog,
  assistantLiveOrbState,
} from "./assistant-live";
import { useAssistantChat, type AssistantChat } from "./use-assistant-chat";
import { useAssistantLive, type AssistantLiveController } from "./use-assistant-live";

const AIDEN_LOGO_URL = new URL("../../../resources/aiden-sidebar-logo.png", import.meta.url).href;
const GEMINI_LIVE_SETUP_COMPLETE_KEY = "aiden.gemini-live.setup-complete";

function storedSetupComplete(): boolean {
  try {
    return window.localStorage.getItem(GEMINI_LIVE_SETUP_COMPLETE_KEY) === "true";
  } catch {
    return false;
  }
}

export function AssistantDock({ rightInset = 0 }: { rightInset?: number }): React.ReactElement {
  const navigate = useNavigate();
  const chat = useAssistantChat();
  const ordinaryApprovalPending = chat.approvals.some(
    (approval) => approval.toolName !== "computer_use",
  );
  const live = useAssistantLive(
    chat.activeChatId,
    ordinaryApprovalPending
      ? "Decide the pending automation approval before starting Live."
      : chat.streaming
        ? "Finish or stop the current Aiden response before starting Live."
        : null,
  );
  const openSettings = React.useCallback(
    (section: SettingsSection) => {
      live.setSetupOpen(false);
      void navigate({ to: "/settings", search: { section } });
    },
    [live, navigate],
  );
  return (
    <AssistantDockPresentation
      chat={chat}
      live={live}
      rightInset={rightInset}
      onOpenSettings={openSettings}
    />
  );
}

export function AssistantDockPresentation({
  chat,
  live,
  rightInset = 0,
  onOpenSettings = () => undefined,
  useCommand = useCommandHandler,
}: {
  chat: AssistantChat;
  live: AssistantLiveController;
  rightInset?: number;
  onOpenSettings?: (section: "providers" | "computerUse" | "scheduledTasks") => void;
  useCommand?: typeof useCommandHandler;
}): React.ReactElement {
  const [hudOpen, setHudOpen] = React.useState(false);
  const [setupCompleted, setSetupCompleted] = React.useState(storedSetupComplete);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const approvalPending = chat.approvals.some((approval) => approval.toolName === "computer_use");
  const orbState = assistantLiveOrbState(live, approvalPending);

  React.useEffect(() => {
    if (approvalPending || live.error) setHudOpen(true);
    if (!live.active) setHudOpen(false);
  }, [approvalPending, live.active, live.error]);

  React.useEffect(() => {
    if (!live.active || !live.microphoneActive || setupCompleted) return;
    setSetupCompleted(true);
    try {
      window.localStorage.setItem(GEMINI_LIVE_SETUP_COMPLETE_KEY, "true");
    } catch {
      // A private/locked storage context should not prevent the active session.
    }
  }, [live.active, live.microphoneActive, setupCompleted]);

  const openPanel = React.useCallback(() => {
    if (!setupCompleted) {
      live.setSetupOpen(true);
      return;
    }
    if (live.active) {
      setHudOpen((open) => !open);
      return;
    }
    if (live.setupComplete) {
      void live.start();
      return;
    }
    onOpenSettings(live.available ? "computerUse" : "providers");
  }, [live, onOpenSettings, setupCompleted]);
  useCommand("assistant.open", openPanel);

  return (
    <div
      className="pointer-events-none absolute bottom-4 z-40 flex flex-col items-end gap-2 transition-[right] duration-300 ease-out motion-reduce:transition-none"
      style={{ right: `calc(1rem + ${Math.max(0, rightInset)}px)` }}
    >
      {live.active && hudOpen ? <AssistantLiveHud live={live} orbState={orbState} /> : null}
      <button
        ref={triggerRef}
        type="button"
        className="aiden-live-trigger pointer-events-auto"
        data-kind={setupCompleted ? "orb" : "logo"}
        data-state={orbState}
        aria-label={
          !setupCompleted
            ? "Set up Gemini Live"
            : live.active
              ? `${hudOpen ? "Hide" : "Show"} Gemini Live controls`
              : "Start Gemini Live"
        }
        aria-expanded={live.active ? hudOpen : live.setupOpen}
        onClick={openPanel}
      >
        {setupCompleted ? (
          <AidenLiveOrb state={orbState} level={live.microphoneLevel} />
        ) : (
          <img src={AIDEN_LOGO_URL} alt="" draggable={false} />
        )}
        {approvalPending ? <span className="aiden-live-trigger-badge" aria-hidden="true" /> : null}
      </button>
      {!setupCompleted ? (
        <AssistantLiveSetupDialog live={live} onOpenSettings={onOpenSettings} />
      ) : null}
    </div>
  );
}
