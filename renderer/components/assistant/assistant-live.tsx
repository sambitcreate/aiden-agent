import * as React from "react";
import { Mic, MonitorOff, Radio, Square } from "lucide-react";
import { Button, Dialog, Switch } from "../ui";
import { computerUseControlState } from "../../lib/computer-use-control";
import type { AssistantLiveController } from "./use-assistant-live";

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
  return (
    <div className="space-y-3">
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
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex items-center justify-between border-b border-separator px-3 py-2">
            <div className="min-w-0">
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-1.5 text-sm font-medium text-primary"
              >
                <Radio className="size-3.5 text-accent" aria-hidden="true" />{" "}
                {STATE_LABEL[live.state]}
              </p>
              <p className="mt-0.5 text-xs text-tertiary">
                {live.microphoneActive
                  ? "Microphone on"
                  : live.busy
                    ? "Starting microphone…"
                    : "Microphone off"}{" "}
                · Sent to Google Gemini
                {live.model ? ` · ${live.model}` : ""}
              </p>
            </div>
            <Button
              variant="filled"
              size="small"
              className={ASSISTANT_LIVE_FOCUS_CLASS}
              onClick={() => void live.stop()}
              disabled={live.busy}
            >
              <Square className="fill-current" aria-hidden="true" /> Stop
            </Button>
          </div>
          <div
            className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
            aria-label="Live captions"
          >
            {live.captions.length ? (
              live.captions.map((caption) => (
                <p
                  key={caption.id}
                  className="mb-2 text-sm leading-5 text-primary"
                >
                  <span className="mr-1.5 text-xs font-medium text-tertiary">
                    {caption.direction === "input" ? "You" : "Aiden"}
                  </span>
                  <span>{caption.text}</span>
                  {caption.final ? null : (
                    <span className="sr-only">, interim</span>
                  )}
                </p>
              ))
            ) : (
              <p className="text-sm text-tertiary">
                {live.microphoneActive
                  ? "Start speaking when you’re ready."
                  : live.busy
                    ? "Preparing your microphone…"
                    : "The microphone is not capturing."}
              </p>
            )}
            <div
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              className="sr-only"
            >
              {live.captions
                .filter((caption) => caption.final)
                .map((caption) => (
                  <p key={caption.id}>
                    {caption.direction === "input" ? "You" : "Aiden"}:{" "}
                    {caption.text}
                  </p>
                ))}
            </div>
          </div>
          {live.error ? (
            <p
              role="alert"
              className="border-t border-separator px-3 py-2 text-xs text-support-red"
            >
              {live.error}
            </p>
          ) : null}
        </section>
      ) : (
        <div className="px-3 pt-2">
          <div className="rounded-xl bg-well px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-primary">
                  <Radio className="size-3.5 text-accent" aria-hidden="true" />{" "}
                  Gemini Live
                  <span className="rounded-full bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-tertiary">
                    Experimental
                  </span>
                </p>
                <p className="mt-1 text-xs text-secondary">
                  {live.availabilityDetail}
                </p>
                <p className="mt-1 text-xs text-tertiary">
                  {live.microphonePermissionDetail}
                </p>
              </div>
              <Button
                variant="filled"
                size="small"
                className={`${ASSISTANT_LIVE_FOCUS_CLASS} shrink-0`}
                onClick={() => live.setSetupOpen(true)}
                disabled={Boolean(live.startBlockedReason)}
                title={live.startBlockedReason ?? undefined}
              >
                {live.reconnectRequired ? "Reconnect" : "Start"}
              </Button>
            </div>
          </div>
          {live.startBlockedReason ? (
            <p role="status" className="mt-1.5 text-xs text-tertiary">
              {live.startBlockedReason}
            </p>
          ) : null}
          {live.error ? (
            <p role="alert" className="mt-1.5 text-xs text-support-red">
              {live.error}
            </p>
          ) : null}
        </div>
      )}
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
