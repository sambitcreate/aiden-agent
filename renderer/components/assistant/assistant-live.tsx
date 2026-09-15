import * as React from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Mic,
  MousePointer2,
  Radio,
  Settings2,
  Square,
} from "lucide-react";
import { Badge, Button, Dialog } from "../ui";
import { AidenLiveOrb, type AidenLiveOrbState } from "./aiden-live-orb";
import type { AssistantLiveCaption, AssistantLiveController } from "./use-assistant-live";

export const ASSISTANT_LIVE_FOCUS_CLASS =
  "focus-visible:ring-[3px] focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover";

const STATE_LABEL: Record<AssistantLiveController["state"], string> = {
  idle: "Ready",
  connecting: "Connecting…",
  open: "Live",
  resuming: "Resuming…",
  closing: "Stopping…",
  closed: "Stopped",
  failed: "Unavailable",
  disconnected: "Disconnected",
};

export function assistantLiveTranscriptFollowsLatest(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= 24;
}

export function assistantLiveOrbState(
  live: AssistantLiveController,
  approvalPending = false,
): AidenLiveOrbState {
  if (!live.available && !live.setupComplete) return "unavailable";
  if (live.error || ["failed", "disconnected"].includes(live.state)) return "error";
  if (approvalPending) return "approval";
  if (live.busy || ["connecting", "resuming", "closing"].includes(live.state)) return "connecting";
  if (!live.active) return "ready";
  const latest = live.captions[live.captions.length - 1];
  if (latest?.direction === "input" && latest.final) return "thinking";
  return live.microphoneActive ? "listening" : "ready";
}

function ReadinessRow({
  icon,
  title,
  detail,
  ready,
  busy = false,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  ready: boolean;
  busy?: boolean;
  action: string;
  onAction(): void;
}): React.ReactElement {
  return (
    <div className="gemini-live-readiness-row">
      <span className="gemini-live-readiness-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-primary">{title}</span>
        <span className="mt-0.5 block text-xs leading-4 text-secondary">{detail}</span>
      </span>
      {ready ? (
        <span className="gemini-live-ready-mark" aria-label="Ready">
          <Check className="size-3.5" aria-hidden="true" />
        </span>
      ) : (
        <Button
          size="small"
          variant="transparent"
          className={ASSISTANT_LIVE_FOCUS_CLASS}
          onClick={onAction}
          disabled={busy}
        >
          {busy ? "Working…" : action}
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export function AssistantLiveSetupDialog({
  live,
  onOpenSettings,
}: {
  live: AssistantLiveController;
  onOpenSettings(section: "providers" | "computerUse" | "scheduledTasks"): void;
}): React.ReactElement {
  const accessibilityReady = live.computerUsePermissions?.accessibility === true;
  const screenReady = live.computerUsePermissions?.screenRecording === true;
  return (
    <Dialog
      open={live.setupOpen}
      onOpenChange={live.setSetupOpen}
      title="Set up Gemini Live"
      description="Give Aiden only the access it needs. Nothing is captured until you start a Live session."
      confirmLabel={live.busy ? "Starting…" : "Start Live"}
      confirmDisabled={!live.setupComplete || live.busy || Boolean(live.startBlockedReason)}
      cancelLabel={live.busy ? "Stop" : "Not now"}
      allowCancelWhileBusy
      actionClassName={ASSISTANT_LIVE_FOCUS_CLASS}
      busy={live.busy}
      onConfirm={live.start}
    >
      <div className="gemini-live-setup-hero">
        <AidenLiveOrb state={live.setupComplete ? "ready" : "connecting"} />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-primary">Aiden, ready to listen and act</p>
            <Badge color="blue">Beta</Badge>
          </div>
          <p className="mt-0.5 text-xs leading-4 text-secondary">
            Voice, screen context, and accessibility actions stay visible and stoppable.
          </p>
        </div>
      </div>
      {live.error ? (
        <p role="alert" className="gemini-live-setup-error">
          {live.error}
        </p>
      ) : null}
      <div className="gemini-live-readiness-list">
        <ReadinessRow
          icon={<Radio className="size-4" />}
          title="Google Live model"
          detail={live.availabilityDetail}
          ready={live.available}
          action="Connect"
          onAction={() => onOpenSettings("providers")}
        />
        <ReadinessRow
          icon={<Mic className="size-4" />}
          title="Microphone"
          detail={live.microphonePermissionDetail}
          ready={live.microphonePermission === "granted"}
          action="Allow"
          onAction={() => void live.requestMicrophonePermission()}
        />
        <ReadinessRow
          icon={<MousePointer2 className="size-4" />}
          title="Screen and Accessibility"
          detail={
            accessibilityReady && screenReady && live.computerUseEnabled
              ? "Aiden can inspect the screen and propose one action at a time."
              : live.computerUseDetail
          }
          ready={live.computerUseReady && live.computerUseEnabled}
          busy={live.computerUseBusy}
          action="Allow"
          onAction={() => void live.prepareComputerUse()}
        />
        <ReadinessRow
          icon={<Settings2 className="size-4" />}
          title="Scheduled tasks"
          detail="Live can open Aiden and create recurring or one-time tasks with your confirmation."
          ready
          action="Review"
          onAction={() => onOpenSettings("scheduledTasks")}
        />
      </div>
      {live.computerUseError ? (
        <button
          type="button"
          className="gemini-live-inline-error"
          onClick={() => onOpenSettings("computerUse")}
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span>{live.computerUseError}</span>
          <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
        </button>
      ) : null}
      <p className="text-xs leading-4 text-tertiary">
        Screen actions use Computer Use and still require Allow once. Audio and captions remain in
        memory for this Live session and are not added to chat history.
      </p>
    </Dialog>
  );
}

function Transcript({ captions }: { captions: readonly AssistantLiveCaption[] }) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const followLatest = React.useRef(true);
  const latestText = captions[captions.length - 1]?.text ?? "";
  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && followLatest.current) viewport.scrollTop = viewport.scrollHeight;
  }, [captions.length, latestText]);
  return (
    <div
      ref={viewportRef}
      className="gemini-live-hud-transcript"
      aria-label="Live captions"
      onScroll={(event) => {
        const viewport = event.currentTarget;
        followLatest.current = assistantLiveTranscriptFollowsLatest(
          viewport.scrollHeight,
          viewport.scrollTop,
          viewport.clientHeight,
        );
      }}
    >
      {captions.length === 0 ? (
        <p className="text-secondary">Start speaking when you’re ready.</p>
      ) : (
        captions.slice(-4).map((turn) => (
          <p key={turn.id}>
            <span>{turn.direction === "input" ? "You" : "Aiden"}</span> {turn.text}
          </p>
        ))
      )}
    </div>
  );
}

export function AssistantLiveHud({
  live,
  orbState,
}: {
  live: AssistantLiveController;
  orbState: AidenLiveOrbState;
}): React.ReactElement {
  return (
    <section className="gemini-live-hud" aria-label="Gemini Live conversation">
      <div className="gemini-live-hud-header">
        <AidenLiveOrb state={orbState} level={live.microphoneLevel} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p role="status" aria-live="polite" className="text-sm font-medium text-primary">
              {STATE_LABEL[live.state]}
            </p>
            {orbState === "approval" ? <Badge color="blue">Approval needed</Badge> : null}
          </div>
          <p className="truncate text-xs text-tertiary" title={live.model ?? "Google Gemini"}>
            Google Gemini{live.model ? ` · ${live.model}` : ""}
          </p>
        </div>
        <Button
          variant="filled"
          size="small"
          iconOnly
          className={ASSISTANT_LIVE_FOCUS_CLASS}
          aria-label="Stop Live"
          title="Stop Live"
          onClick={() => void live.stop()}
          disabled={live.busy}
        >
          <Square className="size-3.5 fill-current" aria-hidden="true" />
        </Button>
      </div>
      <Transcript captions={live.captions} />
      {live.error ? (
        <p role="alert" className="gemini-live-hud-error">
          {live.error}
        </p>
      ) : null}
    </section>
  );
}

/** @deprecated Kept only for the retired panel's source-level compatibility. */
export function AssistantLive({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement | null {
  if (!live.visible) return null;
  return (
    <>
      {live.active ? <AssistantLiveHud live={live} orbState={assistantLiveOrbState(live)} /> : null}
      <AssistantLiveSetupDialog live={live} onOpenSettings={() => undefined} />
    </>
  );
}

/** @deprecated The window-level Live orb is now the only entry point. */
export function AssistantLiveEntryPoint({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement | null {
  if (!live.visible || live.active) return null;
  return (
    <Button size="small" onClick={() => live.setSetupOpen(true)}>
      Set up Gemini Live
    </Button>
  );
}

/** @deprecated Setup moved to AssistantLiveSetupDialog. */
export function AssistantLiveSetupContent({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement {
  return <p className="text-sm text-secondary">{live.availabilityDetail}</p>;
}
