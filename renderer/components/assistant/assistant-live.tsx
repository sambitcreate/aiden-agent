import * as React from "react";
import { Mic, MonitorOff, Radio, Square } from "lucide-react";
import { Button, Dialog, Switch } from "../ui";
import { computerUseControlState } from "../../lib/computer-use-control";
import type {
  AssistantLiveCaption,
  AssistantLiveController,
} from "./use-assistant-live";

export const ASSISTANT_LIVE_FOCUS_CLASS =
  "focus-visible:ring-[3px] focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover";

const STATE_LABEL: Record<AssistantLiveController["state"], string> = {
  idle: "Ready",
  connecting: "Connecting…",
  open: "Listening",
  resuming: "Resuming…",
  closing: "Stopping…",
  closed: "Stopped",
  failed: "Unavailable",
  disconnected: "Disconnected",
};

function presenceDetail(live: AssistantLiveController): string {
  if (live.microphoneActive) return "Start speaking when you’re ready.";
  if (live.busy) return "Preparing your microphone…";
  return "The microphone is not capturing.";
}

export function assistantLiveTranscriptFollowsLatest(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= 24;
}

function AssistantLiveTranscript({
  captions,
}: {
  captions: readonly AssistantLiveCaption[];
}): React.ReactElement {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const followLatest = React.useRef(true);
  const latestText = captions[captions.length - 1]?.text ?? "";

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followLatest.current) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [captions.length, latestText]);

  return (
    <div
      ref={viewportRef}
      className="assistant-live-transcript min-h-0 flex-1 overflow-y-auto px-3"
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
      {captions.map((turn) => (
        <p key={turn.id} className="assistant-live-caption-turn">
          <span className="assistant-live-caption-speaker">
            {turn.direction === "input" ? "You" : "Aiden"}
          </span>
          <span>{turn.text}</span>
          {turn.final ? null : <span className="sr-only">, interim</span>}
        </p>
      ))}
      <div
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        className="sr-only"
      >
        {captions
          .filter((turn) => turn.sealed)
          .map((turn) => (
            <p key={turn.id}>
              {turn.direction === "input" ? "You" : "Aiden"}: {turn.text}
            </p>
          ))}
      </div>
    </div>
  );
}

function AssistantLivePresence({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement {
  return (
    <div
      className="assistant-live-presence"
      data-state={live.state}
      data-has-captions={live.captions.length > 0}
      data-microphone-active={live.microphoneActive}
    >
      <div className="assistant-live-orb" aria-hidden="true">
        <span className="assistant-live-orb-core">
          <span className="assistant-live-orb-pearl" />
        </span>
      </div>
      <p className="assistant-live-presence-detail">{presenceDetail(live)}</p>
    </div>
  );
}

function AssistantLiveControlDock({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement {
  return (
    <div
      className="assistant-live-control-dock"
      role="group"
      aria-label="Live controls"
      data-state={live.state}
      data-microphone-active={live.microphoneActive}
    >
      <div
        className="assistant-live-microphone-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Mic className="size-4" aria-hidden="true" />
        <span>
          {live.microphoneActive
            ? "Microphone on"
            : live.busy
              ? "Starting microphone…"
              : "Microphone off"}
        </span>
      </div>
      <div className="assistant-live-signal" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <span key={index} />
        ))}
      </div>
      <Button
        variant="filled"
        size="small"
        iconOnly
        className={`${ASSISTANT_LIVE_FOCUS_CLASS} assistant-live-stop-button`}
        aria-label="Stop Live"
        title="Stop Live"
        onClick={() => void live.stop()}
        disabled={live.busy}
      >
        <Square className="fill-current" aria-hidden="true" />
      </Button>
    </div>
  );
}

export function AssistantLiveSetupContent({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement {
  const computerUseControl = computerUseControlState({
    enabled: live.computerUseEnabled,
    ready: live.computerUseReady,
    busy: live.computerUseBusy,
  });
  const distinctBlockedReason =
    live.startBlockedReason &&
    live.startBlockedReason !== live.availabilityDetail &&
    live.startBlockedReason !== live.microphonePermissionDetail
      ? live.startBlockedReason
      : null;
  return (
    <div className="space-y-3">
      {live.error ? (
        <p
          role="alert"
          className="rounded-xl bg-support-red/10 px-3 py-2 text-xs leading-4 text-support-red"
        >
          {live.error}
        </p>
      ) : distinctBlockedReason ? (
        <p
          role="status"
          className="rounded-xl bg-well px-3 py-2 text-xs leading-4 text-secondary"
        >
          {distinctBlockedReason}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-4 rounded-xl bg-well px-3 py-2.5">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-primary">
            <Mic className="size-4" aria-hidden="true" /> Microphone
          </p>
          <p
            id="assistant-live-mic-detail"
            className="mt-0.5 text-xs text-secondary"
          >
            Streams 16 kHz audio only while this session is open.
          </p>
          <p className="mt-1 text-xs text-tertiary">
            {live.microphonePermissionDetail}
          </p>
        </div>
        <Switch
          className={ASSISTANT_LIVE_FOCUS_CLASS}
          checked={live.microphone}
          onCheckedChange={live.setMicrophone}
          aria-label="Share microphone"
          aria-describedby="assistant-live-mic-detail"
        />
      </div>
      <div className="rounded-xl bg-well px-3 py-2.5">
        <p className="text-sm font-medium text-primary">Model</p>
        <p className="mt-0.5 break-words text-xs text-secondary">
          {live.availabilityDetail}
        </p>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-xl bg-well px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-primary">Computer Use</p>
          <p
            id="assistant-live-computer-use-detail"
            className="mt-0.5 text-xs text-secondary"
          >
            {live.computerUseEnabled
              ? "Enabled only for this Assistant conversation. Every action still requires Allow once."
              : "Off for this Assistant conversation. Live cannot declare the tool."}
          </p>
          <p className="mt-1 text-xs text-tertiary">
            Global readiness: {live.computerUseDetail}
          </p>
          {!live.computerUseConversationAvailable ? (
            <p className="mt-1 text-xs text-tertiary">
              Start an Assistant conversation before enabling it for Live.
            </p>
          ) : null}
          {live.computerUseError ? (
            <p
              id="assistant-live-computer-use-error"
              role="alert"
              className="mt-1 text-xs text-support-red"
            >
              {live.computerUseError}
            </p>
          ) : null}
        </div>
        <Switch
          className={`${ASSISTANT_LIVE_FOCUS_CLASS} mt-0.5 shrink-0`}
          checked={live.computerUseEnabled}
          disabled={computerUseControl.disabled}
          aria-disabled={computerUseControl.ariaDisabled || undefined}
          onCheckedChange={(enabled) => {
            if (!computerUseControl.ariaDisabled)
              void live.setComputerUse(enabled);
          }}
          aria-label="Enable Computer Use for this Assistant conversation"
          aria-describedby={`assistant-live-computer-use-detail${live.computerUseError ? " assistant-live-computer-use-error" : ""}`}
          title={
            !live.computerUseReady && !live.computerUseEnabled
              ? live.computerUseDetail
              : undefined
          }
        />
      </div>
      <div
        className="flex items-start gap-2 rounded-xl bg-well px-3 py-2.5 text-secondary"
        aria-disabled="true"
      >
        <MonitorOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium text-primary">
            Screen sharing unavailable
          </p>
          <p className="mt-0.5 text-xs">
            Screen and window selection stays off until the native macOS picker
            passes operator acceptance.
          </p>
        </div>
      </div>
      <p className="text-xs leading-4 text-secondary">
        Audio and captions stay in memory for this session and are not added to
        chat history. Stopping never reconnects automatically.
      </p>
    </div>
  );
}

export function AssistantLiveEntryPoint({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement | null {
  if (!live.visible || live.active) return null;
  const action = live.reconnectRequired
    ? "Reconnect Gemini Live"
    : "Start Gemini Live";
  const blocked = Boolean(live.startBlockedReason);
  return (
    <Button
      variant="transparent"
      size="small"
      iconOnly
      className={`${ASSISTANT_LIVE_FOCUS_CLASS} assistant-live-entry-button`}
      aria-label={
        blocked ? `${action} unavailable: ${live.startBlockedReason}` : action
      }
      aria-haspopup="dialog"
      aria-expanded={live.setupOpen}
      title={live.startBlockedReason ?? action}
      data-state={
        live.setupOpen ? "open" : live.reconnectRequired ? "reconnect" : "idle"
      }
      disabled={blocked || live.busy}
      onClick={() => live.setSetupOpen(true)}
    >
      <span className="assistant-live-entry-material" aria-hidden="true" />
    </Button>
  );
}

export function AssistantLive({
  live,
}: {
  live: AssistantLiveController;
}): React.ReactElement | null {
  if (!live.visible) return null;
  return (
    <>
      {live.active ? (
        <section
          aria-label="Live conversation"
          className="assistant-live-shell flex min-h-0 flex-1 flex-col"
          style={
            {
              "--assistant-live-level": live.microphoneLevel.toFixed(3),
              "--assistant-live-bar-scale": (
                0.35 +
                live.microphoneLevel * 1.1
              ).toFixed(3),
              "--assistant-live-orb-scale": (
                0.98 +
                live.microphoneLevel * 0.08
              ).toFixed(3),
              "--assistant-live-orb-bloom": (
                0.96 +
                live.microphoneLevel * 0.1
              ).toFixed(3),
              "--assistant-live-orb-speed": `${(
                5.2 -
                live.microphoneLevel * 3.4
              ).toFixed(2)}s`,
              "--assistant-live-orb-glow": `${(
                20 +
                live.microphoneLevel * 26
              ).toFixed(1)}px`,
            } as React.CSSProperties
          }
        >
          <div className="assistant-live-session-header">
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-1.5 text-sm font-medium text-primary"
            >
              <Radio className="size-3.5 text-accent" aria-hidden="true" />{" "}
              {STATE_LABEL[live.state]}
            </p>
            <p
              className="mt-0.5 truncate text-xs text-tertiary"
              title={live.model ?? "Google Gemini"}
            >
              Google Gemini{live.model ? ` · ${live.model}` : ""}
            </p>
          </div>
          <AssistantLivePresence live={live} />
          <AssistantLiveTranscript captions={live.captions} />
          {live.error ? (
            <p
              role="alert"
              className="border-t border-separator px-3 py-2 text-xs text-support-red"
            >
              {live.error}
            </p>
          ) : null}
          <div className="assistant-live-control-wrap">
            <AssistantLiveControlDock live={live} />
          </div>
        </section>
      ) : null}
      <Dialog
        open={live.setupOpen}
        onOpenChange={live.setSetupOpen}
        title="Start Live"
        description="A real-time voice conversation with Google Gemini. Capture starts only after you choose Start."
        confirmLabel={live.busy ? "Starting…" : "Start"}
        confirmDisabled={
          !live.microphone || live.busy || Boolean(live.startBlockedReason)
        }
        cancelLabel={live.busy ? "Stop" : "Cancel"}
        allowCancelWhileBusy
        actionClassName={ASSISTANT_LIVE_FOCUS_CLASS}
        busy={live.busy}
        onConfirm={live.start}
      >
        <AssistantLiveSetupContent live={live} />
      </Dialog>
    </>
  );
}
