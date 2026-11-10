// Aiden Live's floating ribbon: a dark glass pill above the chat composer that
// shows what Live is doing (listening, thinking, speaking, acting) or what it
// needs from you, with the last lines of the conversation above it.

import * as React from "react";
import { Ellipsis, Mic, MicOff, Monitor, X } from "lucide-react";
import type { LiveActivity } from "../../lib/live-activity";
import {
  AIDEN_LIVE_SPEEDS,
  AIDEN_LIVE_VOICES,
  type AidenLivePreferences,
  type AidenLiveRibbonColors,
} from "../../shared/aiden-live-settings";
import { LIVE_CONFIRM_ANSWER_ATTRIBUTE } from "../../shared/live-app-control";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui";
import type { AidenLiveMarkState } from "./aiden-live-mark";
import { LiveRibbonWave, type LiveRibbonMotion } from "./live-ribbon-wave";
import type { AidenLivePreferencesPatch } from "./use-aiden-live-preferences";
import type { AssistantLiveCaption, AssistantLiveController } from "./use-assistant-live";
import { useLiveRibbonPlacement } from "./use-live-ribbon-placement";

export type LiveRibbonState = "listening" | "thinking" | "speaking" | "acting" | "approval" | "confirm";

/** What the pill shows: a request that needs you wins over what Live is doing. */
export function liveRibbonState(markState: AidenLiveMarkState, activity: LiveActivity | null): LiveRibbonState {
  if (activity?.kind === "approval") return "approval";
  if (activity?.kind === "confirm") return "confirm";
  // The legacy Computer Use prompt shows above the pill.
  if (markState === "approval") return "approval";
  if (activity?.kind === "acting" || markState === "acting") return "acting";
  if (markState === "speaking") return "speaking";
  if (markState === "thinking" || markState === "connecting") return "thinking";
  return "listening";
}

const SPEED_LABEL = (speed: number) => `${speed}×`;

const RIBBON_COLOR_LABEL: Record<AidenLiveRibbonColors, string> = {
  spectrum: "Spectrum",
  accent: "Theme accent",
};

/** The ••• menu's rows; separate so the menu can be checked without the pill. */
export function LiveRibbonMenuItems({
  preferences,
  onChange,
}: {
  preferences: Pick<AidenLivePreferences, "voice" | "speed" | "ribbonColors">;
  onChange(patch: AidenLivePreferencesPatch): void;
}): React.ReactElement {
  const current = AIDEN_LIVE_VOICES.find((voice) => voice.id === preferences.voice);
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span>Voice</span>
            <span className="truncate text-small text-tertiary">{current?.id ?? preferences.voice}</span>
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          data-live-guard="you"
          className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto"
        >
          <DropdownMenuLabel>New voice starts next time</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-label="Voice"
            value={preferences.voice}
            onValueChange={(voice) => onChange({ aidenLiveVoice: voice })}
          >
            {AIDEN_LIVE_VOICES.map((voice) => (
              <DropdownMenuRadioItem key={voice.id} value={voice.id}>
                <span>{voice.id}</span>
                <span className="text-small text-tertiary">{voice.character}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuLabel id="live-ribbon-speed-label">Speaking speed</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-labelledby="live-ribbon-speed-label"
        value={String(preferences.speed)}
        onValueChange={(speed) => onChange({ aidenLiveSpeed: Number(speed) })}
      >
        {AIDEN_LIVE_SPEEDS.map((speed) => (
          <DropdownMenuRadioItem key={speed} value={String(speed)} onSelect={(event) => event.preventDefault()}>
            {SPEED_LABEL(speed)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel id="live-ribbon-colors-label">Ribbon colours</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-labelledby="live-ribbon-colors-label"
        value={preferences.ribbonColors}
        onValueChange={(colors) => onChange({ aidenLiveRibbonColors: colors as AidenLiveRibbonColors })}
      >
        {(Object.keys(RIBBON_COLOR_LABEL) as AidenLiveRibbonColors[]).map((colors) => (
          <DropdownMenuRadioItem key={colors} value={colors} onSelect={(event) => event.preventDefault()}>
            {RIBBON_COLOR_LABEL[colors]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

function latestLine(captions: readonly AssistantLiveCaption[], direction: AssistantLiveCaption["direction"]) {
  for (let index = captions.length - 1; index >= 0; index -= 1) {
    const caption = captions[index]!;
    if (caption.direction === direction && caption.text.trim()) return caption.text;
  }
  return null;
}

function statusText(state: LiveRibbonState, activity: LiveActivity | null, muted: boolean, connecting: boolean): string {
  if (connecting) return "Connecting…";
  switch (state) {
    case "approval":
      return activity?.kind === "approval" ? `Needs you: ${activity.title}` : "Needs you";
    case "confirm":
      return activity?.kind === "confirm" ? `Confirm: ${activity.label}` : "Confirm";
    case "acting":
      return activity?.kind === "acting" ? activity.label : "Working";
    case "speaking":
      return "Speaking";
    case "thinking":
      return "Thinking";
    case "listening":
      return muted ? "Live · mic off" : "Listening";
  }
}

const MOTION: Record<LiveRibbonState, LiveRibbonMotion> = {
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  acting: "waiting",
  approval: "waiting",
  confirm: "waiting",
};

export function LiveRibbon({
  live,
  markState,
  activity,
  preferences,
  onPreferencesChange,
  children,
}: {
  live: AssistantLiveController;
  markState: AidenLiveMarkState;
  activity: LiveActivity | null;
  preferences: Pick<AidenLivePreferences, "voice" | "speed" | "ribbonColors">;
  onPreferencesChange(patch: AidenLivePreferencesPatch): void;
  /** Extra prompts shown above the pill (the legacy Computer Use approval). */
  children?: React.ReactNode;
}): React.ReactElement {
  const pillRef = React.useRef<HTMLDivElement>(null);
  const sectionRef = React.useRef<HTMLElement>(null);
  const placement = useLiveRibbonPlacement(sectionRef);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const state = liveRibbonState(markState, activity);
  const muted = live.microphoneMuted;
  const micLevel = React.useRef(live.microphoneLevel);
  micLevel.current = muted ? 0 : live.microphoneLevel;
  const { outputLevel } = live;
  const level = React.useCallback(
    () => (state === "speaking" ? outputLevel() : state === "listening" ? micLevel.current : 0),
    [outputLevel, state],
  );
  const compact = state !== "listening" && state !== "thinking" && state !== "speaking";
  const you = latestLine(live.captions, "input");
  const aiden = latestLine(live.captions, "output");
  const hint =
    activity?.kind === "approval" && activity.voice
      ? activity.allow
        ? "Say “allow” or “deny”"
        : "Say “deny”"
      : activity?.kind === "confirm"
        ? "Say “yes, do it”"
        : null;
  const end = () => void live.stop();
  // The pill offers its own answer buttons only for the request it shows.
  const answering =
    (state === "acting" && activity?.kind === "acting") ||
    (state === "approval" && activity?.kind === "approval") ||
    (state === "confirm" && activity?.kind === "confirm");

  return (
    <section
      ref={sectionRef}
      className="live-ribbon"
      aria-label="Aiden Live"
      // Live can press controls in Aiden's window, but never its own End,
      // Mute, Allow, Deny, Confirm or Take over.
      data-live-guard="you"
      data-state={state}
      data-dragging={placement.dragging || undefined}
      style={{ left: placement.left, bottom: placement.bottom }}
    >
      {live.error ? (
        <p role="alert" className="live-ribbon-card live-ribbon-error">
          {live.error}
        </p>
      ) : hint ? (
        <p className="live-ribbon-card live-ribbon-hint">{hint}</p>
      ) : you || aiden ? (
        <div className="live-ribbon-card live-ribbon-captions" role="log" aria-live="polite" aria-label="Live captions">
          {you ? (
            <p>
              <span className="live-ribbon-speaker">You</span> {you}
            </p>
          ) : null}
          {aiden ? (
            <p data-speaker="aiden">
              <span className="live-ribbon-speaker">Aiden</span> {aiden}
            </p>
          ) : null}
        </div>
      ) : null}
      {live.screenActive ? (
        <p className="live-ribbon-chip">
          <Monitor className="size-3.5" aria-hidden="true" />
          Sharing {live.screenSourceLabel ?? "screen"}
        </p>
      ) : null}
      {children}
      <div
        ref={pillRef}
        className="live-ribbon-pill"
        data-compact={compact || undefined}
        onPointerDown={placement.onPointerDown}
        onDoubleClick={placement.onDoubleClick}
        onKeyDown={(event) => {
          // Esc ends Live, but a menu inside the pill closes first.
          if (event.key !== "Escape" || menuOpen || event.defaultPrevented) return;
          if (!pillRef.current?.contains(event.target as Node)) return;
          event.preventDefault();
          end();
        }}
      >
        <LiveRibbonWave
          motion={MOTION[state]}
          level={level}
          colors={preferences.ribbonColors}
          width={compact ? 72 : 168}
          height={compact ? 40 : 48}
        />
        {state === "acting" ? (
          <span className="live-ribbon-text">
            <span className="live-ribbon-title">{activity?.kind === "acting" ? activity.label : "Working on your screen"}</span>
            <span className="live-ribbon-detail">Live is using Aiden</span>
          </span>
        ) : state === "approval" && activity?.kind === "approval" ? (
          <span className="live-ribbon-text">
            <span className="live-ribbon-title">{activity.title}</span>
            <span className="live-ribbon-detail">
              {activity.allow ? `In ${activity.chatTitle}` : `Open “${activity.chatTitle}” to choose`}
            </span>
          </span>
        ) : state === "confirm" && activity?.kind === "confirm" ? (
          <span className="live-ribbon-text">
            <span className="live-ribbon-title">{activity.label}</span>
            <span className="live-ribbon-detail">Live is waiting for you</span>
          </span>
        ) : (
          <span className="live-ribbon-spacer" />
        )}
        {state === "acting" && activity?.kind === "acting" ? (
          <Button size="medium" variant="filled" className="live-ribbon-action" onClick={activity.takeOver}>
            Take over
          </Button>
        ) : null}
        {state === "approval" && activity?.kind === "approval" ? (
          <>
            <Button size="medium" variant="filled" className="live-ribbon-action" onClick={activity.deny}>
              Deny
            </Button>
            {activity.allow ? (
              <Button size="medium" variant="accent" className="live-ribbon-action" onClick={activity.allow}>
                Allow
              </Button>
            ) : null}
          </>
        ) : null}
        {state === "confirm" && activity?.kind === "confirm" ? (
          <>
            <Button
              size="medium"
              variant="filled"
              className="live-ribbon-action"
              {...{ [LIVE_CONFIRM_ANSWER_ATTRIBUTE]: "" }}
              onClick={activity.cancel}
            >
              Cancel
            </Button>
            <Button
              size="medium"
              variant="accent"
              className="live-ribbon-action"
              {...{ [LIVE_CONFIRM_ANSWER_ATTRIBUTE]: "" }}
              onClick={activity.confirm}
            >
              Confirm
            </Button>
          </>
        ) : null}
        {compact ? null : (
          <>
            <Button
              iconOnly
              size="large"
              variant="transparent"
              className="live-ribbon-control"
              aria-label="Mute microphone"
              aria-pressed={muted}
              title={muted ? "Turn the microphone back on" : "Mute microphone"}
              onClick={() => live.setMicrophoneMuted(!muted)}
            >
              {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </Button>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  iconOnly
                  size="large"
                  variant="transparent"
                  className="live-ribbon-control"
                  aria-label="Voice, speed and colours"
                  title="Voice, speed and colours"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              {/* The menu is portaled out of the ribbon, so it carries the guard itself. */}
              <DropdownMenuContent data-live-guard="you" side="top" align="end" className="w-60">
                <LiveRibbonMenuItems preferences={preferences} onChange={onPreferencesChange} />
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {answering ? null : (
          <Button
            iconOnly
            size="large"
            variant="transparent"
            className="live-ribbon-control live-ribbon-end"
            aria-label="End Live"
            title="End Live (Esc)"
            disabled={live.busy}
            onClick={end}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {statusText(state, activity, muted, live.state === "connecting" || live.state === "resuming")}
      </span>
    </section>
  );
}
