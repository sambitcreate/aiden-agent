// The window side of Aiden Live moving through Aiden. Main reads and acts on
// the page through DevTools; this controller decides what only the window can
// know: how many actions this request has taken (the user's next words start
// a new count), whether the user has taken over with their own keyboard or
// mouse, and whether the user said or tapped OK for a guarded control.
// It also drives the Live outline and the ribbon's acting/confirm states.

import {
  LIVE_APP_CONTROL_ACTIVITY_SOURCE,
  LIVE_APP_CONTROL_CONFIRM_TIMEOUT_MS,
  LIVE_APP_CONTROL_MAX_ACTIONS,
} from "../shared/live-app-control";
import { matchLiveVoicePhrase } from "../shared/live-voice-phrases";
import type { LiveActivity } from "./live-activity";
import type { LiveRendererToolContext, LiveRendererToolResult, LiveVoiceInput } from "./live-session-bus";

export interface LiveAppControlState {
  /** Live is acting: the outline is drawn and the ribbon offers Take over. */
  acting: boolean;
  label: string;
}

export interface LiveAppControlDependencies {
  bus: {
    onVoiceInput(listener: (input: LiveVoiceInput) => void): () => void;
    latestVoiceInputId(): number;
    note(text: string): Promise<boolean>;
  };
  activity: { set(source: string, activity: LiveActivity | null): void };
  confirmTimeoutMs?: number;
  /** How long the outline lingers after main stops watching, so steps don't flicker. */
  lingerMs?: number;
  maxActions?: number;
}

/** The parts of a DOM input event the take-over check reads. */
export interface LiveAppControlInputEvent {
  type: string;
  isTrusted: boolean;
  key?: string;
}

const IDLE: LiveAppControlState = { acting: false, label: "" };
const TAKE_OVER_EVENTS = new Set(["keydown", "pointerdown", "mousedown", "wheel", "touchstart"]);

function failure(code: string, message: string): LiveRendererToolResult {
  return { ok: false, error: { code, message } };
}

export class LiveAppControlController {
  private state: LiveAppControlState = IDLE;
  private readonly listeners = new Set<() => void>();
  private actions = 0;
  private takenOver = false;
  /**
   * Live has acted for the user's latest request. Until they speak again, any
   * input of their own takes over, even between steps when no outline shows.
   */
  private requestActive = false;
  private watch: ((result: LiveRendererToolResult) => void) | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmation: { id: string; finish(confirmed: boolean, reason: string): void } | null = null;
  private confirmSequence = 0;
  private readonly stopVoice: () => void;

  constructor(private readonly deps: LiveAppControlDependencies) {
    // New speech from the user is a new request: a fresh count, and Live may act again.
    this.stopVoice = deps.bus.onVoiceInput(() => {
      this.actions = 0;
      this.takenOver = false;
      this.requestActive = false;
    });
  }

  get = (): LiveAppControlState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The renderer tool main calls for every app-control step. */
  handle = async (args: Record<string, unknown>, context: LiveRendererToolContext): Promise<LiveRendererToolResult> => {
    switch (args.op) {
      case "admit":
        return this.admit(typeof args.label === "string" ? args.label.slice(0, 120) : "");
      case "watch":
        return this.watchUntilTakeOver(context.signal);
      case "confirm":
        return this.confirm(typeof args.label === "string" ? args.label.slice(0, 200) : "", context.signal);
      case "note":
        return { ok: typeof args.text === "string" && (await this.deps.bus.note(args.text.slice(0, 2_000))) };
      default:
        return failure("invalid", "Unknown app control step.");
    }
  };

  /**
   * Real keyboard or mouse input in the window. Live's own actions are
   * untrusted DOM events, so only the user's input takes over.
   */
  userInput(event: LiveAppControlInputEvent): void {
    if (!event.isTrusted || !TAKE_OVER_EVENTS.has(event.type)) return;
    if (this.confirmation) {
      if (event.type === "keydown" && event.key === "Escape") this.confirmation.finish(false, "cancelled");
      return;
    }
    if (this.requestActive || this.state.acting || this.watch) this.takeOver();
  }

  /** Stops Live acting and hands the window back until the user speaks again. */
  takeOver = (): void => {
    this.takenOver = true;
    const watch = this.watch;
    this.watch = null;
    watch?.({ ok: true, takenOver: true });
    this.setActing(null);
  };

  /** The Live session ended: drop everything. */
  reset(): void {
    this.actions = 0;
    this.takenOver = false;
    this.requestActive = false;
    this.confirmation?.finish(false, "cancelled");
    const watch = this.watch;
    this.watch = null;
    watch?.({ ok: true, ended: true });
    this.setActing(null);
  }

  dispose(): void {
    this.reset();
    this.stopVoice();
  }

  private admit(label: string): LiveRendererToolResult {
    if (this.takenOver) return failure("taken_over", "The user took over.");
    if (this.actions >= (this.deps.maxActions ?? LIVE_APP_CONTROL_MAX_ACTIONS)) {
      return failure("limit", "That is the action limit for this request.");
    }
    this.actions += 1;
    this.requestActive = true;
    this.setActing(label || "Moving through Aiden");
    return { ok: true, remaining: (this.deps.maxActions ?? LIVE_APP_CONTROL_MAX_ACTIONS) - this.actions };
  }

  private watchUntilTakeOver(signal: AbortSignal): Promise<LiveRendererToolResult> {
    if (this.takenOver) return Promise.resolve({ ok: true, takenOver: true });
    this.watch?.({ ok: true, ended: true });
    if (!this.state.acting) this.setActing("Moving through Aiden");
    return new Promise((resolve) => {
      const finish = (result: LiveRendererToolResult) => {
        signal.removeEventListener("abort", ended);
        if (this.watch === finish) this.watch = null;
        resolve(result);
      };
      const ended = () => {
        if (this.watch !== finish) return;
        finish({ ok: true, ended: true });
        this.lingerThenClear();
      };
      this.watch = finish;
      if (signal.aborted) ended();
      else signal.addEventListener("abort", ended, { once: true });
    });
  }

  private confirm(label: string, signal: AbortSignal): Promise<LiveRendererToolResult> {
    this.confirmation?.finish(false, "cancelled");
    this.setActing(null);
    const id = `confirm-${++this.confirmSequence}`;
    const shownLabel = label || "Use this control";
    return new Promise((resolve) => {
      let settled = false;
      let stopVoice: () => void = () => undefined;
      const finish = (confirmed: boolean, reason: string) => {
        // One answer per prompt: a second tap or phrase can never act again.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopVoice();
        signal.removeEventListener("abort", aborted);
        if (this.confirmation?.id === id) this.confirmation = null;
        this.deps.activity.set(LIVE_APP_CONTROL_ACTIVITY_SOURCE, null);
        resolve({ ok: true, confirmed, reason });
      };
      const aborted = () => finish(false, "cancelled");
      const timer = setTimeout(() => finish(false, "timeout"), this.deps.confirmTimeoutMs ?? LIVE_APP_CONTROL_CONFIRM_TIMEOUT_MS);
      this.confirmation = { id, finish };
      // Tapping Confirm works at once. Its callbacks only ever answer this one
      // guarded action, which main has bound to one element and one action.
      this.deps.activity.set(LIVE_APP_CONTROL_ACTIVITY_SOURCE, {
        kind: "confirm",
        id,
        label: shownLabel,
        confirm: () => finish(true, "confirmed"),
        cancel: () => finish(false, "cancelled"),
      });
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      // Live asks the user aloud. Speech counts only after that prompt was
      // accepted, and only a whole utterance that is a fixed confirm phrase
      // answers yes; anything else refuses. A refused prompt leaves tap only.
      void this.deps.bus
        .note(`Ask the user to say confirm or tap Confirm to allow: ${shownLabel}. Nothing happens until they do.`)
        .catch(() => false)
        .then((sent) => {
          if (settled || !sent) return;
          const promptVoiceId = this.deps.bus.latestVoiceInputId();
          stopVoice = this.deps.bus.onVoiceInput((input) => {
            if (input.id <= promptVoiceId) return;
            const phrase = matchLiveVoicePhrase(input.text);
            if (phrase?.kind === "confirm") finish(true, "confirmed");
            else finish(false, phrase?.kind === "deny" ? "cancelled" : "other_speech");
          });
        });
    });
  }

  private lingerThenClear(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (!this.watch) this.setActing(null);
    }, this.deps.lingerMs ?? 400);
  }

  private setActing(label: string | null): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    const next: LiveAppControlState = label === null ? IDLE : { acting: true, label };
    if (next.acting === this.state.acting && next.label === this.state.label) return;
    this.state = next;
    // A pending confirmation owns the ribbon slot; acting never replaces it.
    if (!this.confirmation) {
      this.deps.activity.set(
        LIVE_APP_CONTROL_ACTIVITY_SOURCE,
        next.acting ? { kind: "acting", label: next.label, takeOver: this.takeOver } : null,
      );
    }
    for (const listener of [...this.listeners]) listener();
  }
}
