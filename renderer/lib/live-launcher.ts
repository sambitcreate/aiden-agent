// The composer's Live entry point. With an empty draft, the button in Send's
// place starts Aiden Live; the window-level dock owns the Live session and
// publishes here whether the composer may offer it and how to start it, so
// the button, the ⌘⌥A shortcut and /assistant all go through one path.

export interface LiveLaunchState {
  /**
   * The composer may offer Live: Live is on in Settings, "Show Live in the
   * send button" is on, and Live can start on this computer.
   */
  offered: boolean;
  /** A session is connecting, running or closing; the composer shows plain Send. */
  sessionActive: boolean;
  /** The first press opens setup instead of starting a session. */
  needsSetup: boolean;
}

type Listener = () => void;

export const LIVE_LAUNCH_IDLE: LiveLaunchState = Object.freeze({
  offered: false,
  sessionActive: false,
  needsSetup: false,
});

export class LiveLauncherStore {
  private state: LiveLaunchState = LIVE_LAUNCH_IDLE;
  private launcher: (() => void) | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly beforeStart = new Set<() => void | Promise<void>>();

  get(): LiveLaunchState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The dock publishes its state and the action a press runs; null withdraws Live. */
  publish(state: LiveLaunchState, launch: (() => void) | null): void {
    this.launcher = launch;
    const next = launch ? state : LIVE_LAUNCH_IDLE;
    if (
      next.offered === this.state.offered &&
      next.sessionActive === this.state.sessionActive &&
      next.needsSetup === this.state.needsSetup
    ) {
      return;
    }
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** A press of the composer's Live button. Does nothing when Live is not offered. */
  launch(): boolean {
    if (!this.launcher || !this.state.offered || this.state.sessionActive) return false;
    this.launcher();
    return true;
  }

  /**
   * Runs before Live takes the microphone, from any entry point. Composer
   * dictation registers here so the two never record at once.
   */
  onBeforeStart(callback: () => void | Promise<void>): () => void {
    this.beforeStart.add(callback);
    return () => this.beforeStart.delete(callback);
  }

  /**
   * Called by the dock right before it opens setup or starts a session.
   * Resolves once every registered capture has let go of the microphone.
   */
  async prepareStart(): Promise<void> {
    await Promise.allSettled(
      [...this.beforeStart].map(async (callback) => {
        // One composer's failure to stop dictation must not block Live.
        await callback();
      }),
    );
  }
}

export const liveLauncher = new LiveLauncherStore();

/**
 * What the composer's last button shows. Live only when the draft is empty,
 * nothing is running and the microphone is free; otherwise Send (or Stop,
 * which the composer handles before asking).
 */
export function composerPrimaryAction(input: {
  liveOffered: boolean;
  liveSessionActive: boolean;
  draftHasContent: boolean;
  running: boolean;
  dictating: boolean;
}): "live" | "send" {
  if (!input.liveOffered || input.liveSessionActive) return "send";
  if (input.running || input.dictating || input.draftHasContent) return "send";
  return "live";
}
