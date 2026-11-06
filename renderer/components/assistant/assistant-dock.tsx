// Aiden's window-level Live control: one compact "Live" pill whose leading
// Helix glyph and label follow the session state.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCommandHandler } from "../../lib/command-system";
import { useSettings } from "../../lib/queries";
import type { SettingsSection } from "../../lib/settings-section";
import { AidenActivityMark } from "../aiden-activity-mark";
import { aidenLiveMark, type AidenLiveMarkState } from "./aiden-live-mark";
import {
  AssistantLiveHud,
  AssistantLiveSetupDialog,
  assistantLiveMarkState,
} from "./assistant-live";
import { AssistantComputerUseApproval } from "./assistant-computer-use-approval";
import { useAssistantLive, type AssistantLiveController } from "./use-assistant-live";
import type { AssistantLiveApprovals } from "./use-assistant-live-approvals";
import { liveActivity, type LiveActivity } from "../../lib/live-activity";
import type { AidenLivePreferences } from "../../shared/aiden-live-settings";
import { LiveRibbon } from "./live-ribbon";
import { useLiveVoiceEnding } from "./live-ribbon-session";
import { useAidenLivePreferences, type AidenLivePreferencesPatch } from "./use-aiden-live-preferences";

const SESSION_ACTIONS: AssistantLiveApprovals = {
  approvals: [],
  decidingApprovalId: null,
  decideApproval: async () => undefined,
};

const DEFAULT_RIBBON_PREFERENCES: Pick<AidenLivePreferences, "voice" | "speed" | "ribbonColors"> = {
  voice: "Puck",
  speed: 1,
  ribbonColors: "spectrum",
};

const AIDEN_LIVE_SETUP_COMPLETE_KEY = "aiden.live.setup-complete";
const LEGACY_GEMINI_LIVE_SETUP_COMPLETE_KEY = "aiden.gemini-live.setup-complete";

export function liveDockClickAction(live: Pick<AssistantLiveController, "state" | "active" | "busy" | "setupComplete">, setupCompleted: boolean, stopRevealed: boolean) {
  if (live.state === "closing") return "none";
  if (live.active) return stopRevealed ? "stop" : "reveal-stop";
  if (live.busy) return "none";
  if (!setupCompleted) return "setup";
  return live.setupComplete ? "start" : "settings";
}

const TRIGGER_LABEL: Record<AidenLiveMarkState, string> = {
  ready: "Live",
  unavailable: "Live",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  acting: "Working",
  approval: "Approve",
  error: "Disconnected",
};

/** Visible pill label. Closing and a revealed Stop override the mark state. */
export function liveTriggerLabel(
  markState: AidenLiveMarkState,
  closing: boolean,
  stopRevealed: boolean,
): string {
  if (closing) return "Stopping…";
  if (stopRevealed) return "Stop";
  return TRIGGER_LABEL[markState];
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
  const settings = useSettings();
  // Until settings load, keep Live off so a disabled feature never flashes on.
  const enabled = settings.data ? settings.data.aidenLiveEnabled !== false : false;
  const buttonVisible = settings.data?.aidenLiveButtonVisible !== false;
  const { preferences, save } = useAidenLivePreferences();
  const activity = React.useSyncExternalStore(
    (listener) => liveActivity.subscribe(listener),
    () => liveActivity.get(),
  );
  // Saying goodbye, or Live's end_session tool, ends the session.
  useLiveVoiceEnding(live);
  // Speaking speed applies to the reply that is playing, not just the next one.
  const { setPlaybackSpeed } = live;
  React.useEffect(() => setPlaybackSpeed(preferences.speed), [preferences.speed, setPlaybackSpeed]);
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
      enabled={enabled}
      buttonVisible={buttonVisible}
      onOpenSettings={openSettings}
      activity={activity}
      preferences={preferences}
      onPreferencesChange={(patch) => void save(patch)}
    />
  );
}

export function AssistantDockPresentation({
  chat,
  live,
  rightInset = 0,
  enabled = true,
  buttonVisible = true,
  onOpenSettings = () => undefined,
  useCommand = useCommandHandler,
  activity = null,
  preferences = DEFAULT_RIBBON_PREFERENCES,
  onPreferencesChange = () => undefined,
}: {
  chat: AssistantLiveApprovals;
  live: AssistantLiveController;
  rightInset?: number;
  /** Settings → Voice & Speech → Aiden Live. Off renders nothing and ignores the Live command. */
  enabled?: boolean;
  /** Settings → Voice & Speech → Aiden Live → Show Live button. Off hides only the idle pill. */
  buttonVisible?: boolean;
  onOpenSettings?: (section: "providers" | "computerUse" | "scheduledTasks") => void;
  useCommand?: typeof useCommandHandler;
  /** What Live is doing or needs, from the shared activity store. */
  activity?: LiveActivity | null;
  preferences?: Pick<AidenLivePreferences, "voice" | "speed" | "ribbonColors">;
  onPreferencesChange?: (patch: AidenLivePreferencesPatch) => void;
}): React.ReactElement {
  const [hudOpen, setHudOpen] = React.useState(Boolean(live.error));
  const [stopRevealed, setStopRevealed] = React.useState(false);
  const [setupCompleted, setSetupCompleted] = React.useState(storedSetupComplete);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const liveApproval = chat.approvals.find((approval) => approval.toolName === "computer_use");
  const approvalPending = Boolean(liveApproval);
  const markState = assistantLiveMarkState(live, approvalPending);

  React.useEffect(() => {
    if (!live.active) setStopRevealed(false);
  }, [live.active]);

  // Turning Aiden Live off ends any session this window owns (once per
  // transition) and closes setup. Main also stops every session on its side.
  const { active, busy, setupOpen, setSetupOpen, stop } = live;
  const disabledStopRequested = React.useRef(false);
  React.useEffect(() => {
    if (enabled) {
      disabledStopRequested.current = false;
      return;
    }
    if ((active || busy) && !disabledStopRequested.current) {
      disabledStopRequested.current = true;
      void stop();
    }
    if (setupOpen) setSetupOpen(false);
  }, [enabled, active, busy, setupOpen, setSetupOpen, stop]);

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
    if (action === "reveal-stop") {
      setStopRevealed(true);
      // The ribbon replaces the corner pill while Live runs: the first press
      // moves focus to its End button, the second ends Live.
      document.querySelector<HTMLElement>(".live-ribbon .live-ribbon-end")?.focus();
      return;
    }
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
  useCommand("assistant.open", openPanel, live.visible && enabled);
  if (!live.visible || !enabled) return <></>;

  const closing = live.state === "closing";
  const showStop = stopRevealed && live.active;
  // Whenever there is a session, a pending approval, or an error to see and
  // stop, the pill stays even if the user hid the idle button.
  const sessionVisible = live.active || live.busy || closing || Boolean(live.error) || approvalPending;
  const glyph = aidenLiveMark(markState);
  const label = liveTriggerLabel(markState, closing, showStop);
  const action = live.active
    ? stopRevealed ? "Stop Aiden Live" : "Show Stop Aiden Live button"
    : !setupCompleted
    ? "Set up Aiden Live"
    : "Start Aiden Live";
  // The accessible name must contain the visible label (WCAG 2.5.3) so voice
  // control can target "Listening" or "Disconnected" by what it shows.
  const accessibleName = action.toLowerCase().includes(label.toLowerCase()) ? action : `${label}, ${action}`;

  const approvalPrompt = liveApproval ? (
    <AssistantComputerUseApproval
      prompt={liveApproval}
      deciding={chat.decidingApprovalId === liveApproval.approvalId}
    />
  ) : null;

  return (
    <>
      {live.active ? (
        <LiveRibbon
          live={live}
          markState={markState}
          activity={activity}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
        >
          {approvalPrompt}
        </LiveRibbon>
      ) : null}
      <div
        className="aiden-live-dock pointer-events-none absolute z-40 flex flex-col items-end gap-2 transition-[right] duration-300 ease-out motion-reduce:transition-none"
        style={{ right: `calc(var(--aiden-live-edge-inset) + ${Math.max(0, rightInset)}px)` }}
      >
        {!live.active && live.error && (hudOpen || live.screenActive) ? (
          <AssistantLiveHud live={live} markState={markState}>
            {approvalPrompt}
          </AssistantLiveHud>
        ) : null}
        {!live.active && (buttonVisible || sessionVisible) ? (
          <button
            ref={triggerRef}
            type="button"
            className="aiden-live-trigger pointer-events-auto"
            data-state={markState}
            data-stop-revealed={showStop}
            disabled={closing}
            aria-label={accessibleName}
            aria-expanded={live.setupOpen}
            onKeyDown={(event) => { if (event.key === "Escape") setStopRevealed(false); }}
            onClick={openPanel}
          >
            <span className="aiden-live-trigger-glyph" aria-hidden="true">
              {showStop ? (
                <span className="aiden-live-stop-symbol" />
              ) : (
                <AidenActivityMark key={glyph.mark} mark={glyph.mark} size={20} active={glyph.active} level={live.microphoneLevel} />
              )}
            </span>
            <span className="aiden-live-trigger-label">{label}</span>
            {approvalPending ? <span className="aiden-live-trigger-badge" aria-hidden="true" /> : null}
          </button>
        ) : null}
        {live.active ? null : (
          <span role="status" aria-live="polite" className="sr-only">
            {live.error ? "Disconnected — see details" : live.busy ? live.state === "closing" ? "Stopping…" : "Connecting…" : "Start Live"}
          </span>
        )}
        {!setupCompleted ? (
          <AssistantLiveSetupDialog live={live} onOpenSettings={onOpenSettings} />
        ) : null}
      </div>
    </>
  );
}
