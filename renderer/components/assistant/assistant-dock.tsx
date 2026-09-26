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
import type { AssistantLiveApprovals } from "./use-assistant-live-approvals";

const SESSION_ACTIONS: AssistantLiveApprovals = {
  approvals: [],
  decidingApprovalId: null,
  decideApproval: async () => undefined,
};

const AIDEN_LOGO_URL = new URL("../../../resources/app-icon.png", import.meta.url).href;
const AIDEN_LIVE_SETUP_COMPLETE_KEY = "aiden.live.setup-complete";
const LEGACY_GEMINI_LIVE_SETUP_COMPLETE_KEY = "aiden.gemini-live.setup-complete";

export function liveDockClickAction(live: Pick<AssistantLiveController, "state" | "active" | "busy" | "setupComplete">, setupCompleted: boolean, stopRevealed: boolean) {
  if (live.state === "closing") return "none";
  if (live.active) return stopRevealed ? "stop" : "reveal-stop";
  if (live.busy) return "none";
  if (!setupCompleted) return "setup";
  return live.setupComplete ? "start" : "settings";
}

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
  const openSettings = React.useCallback(
    (section: SettingsSection) => {
      live.setSetupOpen(false);
      void navigate({ to: "/settings", search: { section } });
    },
    [live, navigate],
  );
  return (
    <AssistantDockPresentation
      chat={SESSION_ACTIONS}
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
  const [hudOpen, setHudOpen] = React.useState(Boolean(live.error));
  const [stopRevealed, setStopRevealed] = React.useState(false);
  const [setupCompleted, setSetupCompleted] = React.useState(storedSetupComplete);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const liveApproval = chat.approvals.find((approval) => approval.toolName === "computer_use");
  const approvalPending = Boolean(liveApproval);
  const orbState = assistantLiveOrbState(live, approvalPending);

  React.useEffect(() => {
    if (!live.active) setStopRevealed(false);
  }, [live.active]);

  React.useEffect(() => {
    if (approvalPending || live.error) setHudOpen(true);
    else if (!live.active) setHudOpen(false);
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
    const action = liveDockClickAction(live, setupCompleted, stopRevealed);
    if (action === "none") return;
    if (action === "stop") { void live.stop(); return; }
    if (action === "reveal-stop") { setStopRevealed(true); return; }
    if (action === "setup") {
      live.setSetupOpen(true);
      return;
    }
    if (action === "start") {
      void live.start();
      return;
    }
    onOpenSettings(live.available ? "computerUse" : "providers");
  }, [live, onOpenSettings, setupCompleted, stopRevealed]);
  useCommand("assistant.open", openPanel, live.visible);
  if (!live.visible) return <></>;

  return (
    <div
      className="aiden-live-dock pointer-events-none absolute z-40 flex flex-col items-end gap-2 transition-[right] duration-300 ease-out motion-reduce:transition-none"
      style={{ right: `calc(var(--aiden-live-edge-inset) + ${Math.max(0, rightInset)}px)` }}
    >
      {(live.active || live.error) && (hudOpen || live.screenActive) ? (
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
        data-stop-revealed={stopRevealed && live.active}
        disabled={live.state === "closing"}
        aria-label={
          live.active
            ? stopRevealed ? "Stop Aiden Live" : "Show Stop Aiden Live button"
            : !setupCompleted
            ? "Set up Aiden Live"
            : "Start Aiden Live"
        }
        aria-expanded={live.active ? stopRevealed : live.setupOpen}
        onKeyDown={(event) => { if (event.key === "Escape") setStopRevealed(false); }}
        onClick={openPanel}
      >
        {setupCompleted ? (
          <AidenLiveOrb state={orbState} level={live.microphoneLevel} />
        ) : (
          <span className="aiden-live-trigger-logo-mask squircle-control">
            <img src={AIDEN_LOGO_URL} alt="" draggable={false} />
          </span>
        )}
        <span className="aiden-live-stop-symbol" aria-hidden="true" />
        {approvalPending ? <span className="aiden-live-trigger-badge" aria-hidden="true" /> : null}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {live.error ? "Disconnected — see details" : live.busy ? live.state === "closing" ? "Stopping…" : "Connecting…" : live.active
          ? live.microphoneActive ? "Listening · mic on" : "Live · mic off"
          : "Start Live"}
      </span>
      {!setupCompleted ? (
        <AssistantLiveSetupDialog live={live} onOpenSettings={onOpenSettings} />
      ) : null}
    </div>
  );
}
