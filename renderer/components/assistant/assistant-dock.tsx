// Aiden's window-level Live control. Before setup it presents the app
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
import { AssistantComputerUseApproval } from "./assistant-computer-use-approval";
import { useAssistantLive, type AssistantLiveController } from "./use-assistant-live";
import {
  useAssistantLiveApprovals,
  type AssistantLiveApprovals,
} from "./use-assistant-live-approvals";

const AIDEN_LOGO_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;
const AIDEN_LIVE_SETUP_COMPLETE_KEY = "aiden.live.setup-complete";
const LEGACY_GEMINI_LIVE_SETUP_COMPLETE_KEY = "aiden.gemini-live.setup-complete";

function storedSetupComplete(): boolean {
  try {
    return (
      window.localStorage.getItem(AIDEN_LIVE_SETUP_COMPLETE_KEY) === "true" ||
      window.localStorage.getItem(LEGACY_GEMINI_LIVE_SETUP_COMPLETE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

export function AssistantDock({ rightInset = 0 }: { rightInset?: number }): React.ReactElement {
  const navigate = useNavigate();
  const live = useAssistantLive(null);
  const chat = useAssistantLiveApprovals(live.captions);
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
  chat: AssistantLiveApprovals;
  live: AssistantLiveController;
  rightInset?: number;
  onOpenSettings?: (section: "providers" | "computerUse" | "scheduledTasks") => void;
  useCommand?: typeof useCommandHandler;
}): React.ReactElement {
  const [hudOpen, setHudOpen] = React.useState(false);
  const [setupCompleted, setSetupCompleted] = React.useState(storedSetupComplete);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const liveApproval = chat.approvals.find((approval) => approval.toolName === "computer_use");
  const approvalPending = Boolean(liveApproval);
  const orbState = assistantLiveOrbState(live, approvalPending);

  React.useEffect(() => {
    if (approvalPending || live.error) setHudOpen(true);
    if (!live.active) setHudOpen(false);
  }, [approvalPending, live.active, live.error]);

  React.useEffect(() => {
    if (!live.active || !live.microphoneActive || setupCompleted) return;
    setSetupCompleted(true);
    try {
      window.localStorage.setItem(AIDEN_LIVE_SETUP_COMPLETE_KEY, "true");
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
      {live.active && hudOpen ? (
        <AssistantLiveHud live={live} orbState={orbState}>
          {liveApproval ? (
            <AssistantComputerUseApproval
              prompt={liveApproval}
              deciding={chat.decidingApprovalId === liveApproval.approvalId}
            />
          ) : null}
        </AssistantLiveHud>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        className="aiden-live-trigger pointer-events-auto"
        data-kind={setupCompleted ? "orb" : "logo"}
        data-state={orbState}
        aria-label={
          !setupCompleted
            ? "Set up Aiden Live"
            : live.active
              ? `${hudOpen ? "Hide" : "Show"} Aiden Live controls`
              : "Start Aiden Live"
        }
        aria-expanded={live.active ? hudOpen : live.setupOpen}
        onClick={openPanel}
      >
        {setupCompleted ? (
          <AidenLiveOrb state={orbState} level={live.microphoneLevel} />
        ) : (
          <span className="aiden-live-trigger-logo-mask squircle-control">
            <img src={AIDEN_LOGO_URL} alt="" draggable={false} />
          </span>
        )}
        {approvalPending ? <span className="aiden-live-trigger-badge" aria-hidden="true" /> : null}
      </button>
      {!setupCompleted ? (
        <AssistantLiveSetupDialog live={live} onOpenSettings={onOpenSettings} />
      ) : null}
    </div>
  );
}
