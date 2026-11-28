/**
 * Goal rounds in a window: when a round is due and a focused desktop window
 * shows that chat (and the screen is unlocked), main asks that window to start
 * the round through its own send path, so the round is an ordinary
 * window-owned run with every tool: the browser, Computer Use, and the
 * approvals only a window can give. Otherwise the round runs without a window.
 *
 * Focus and the lock screen are checked only before the round starts.
 * Computer Use brings other apps to the front, so Aiden losing focus mid-round
 * is expected; the window closing, reloading or showing another chat is not,
 * and stops the round (`closedMidRound`).
 *
 * Every effect is a dependency, so this runs in tests with fakes.
 */

/** What a window says it shows: the chat in its pane (or none), and whether it has focus. */
export interface GoalWindowView {
  chatId: string | null;
  focused: boolean;
}

/** A renderer document that reports its view. */
export interface GoalWindowDocument {
  documentId: string;
  /** Asks the document to start the round with `token`. */
  send(request: GoalWindowRoundRequest): void;
}

/** What main sends the window: start this chat's round now, citing `token`. */
export interface GoalWindowRoundRequest {
  chatId: string;
  token: string;
}

/** How an offered round ended up: started by the window, or no window took it. */
export type GoalWindowRoundResult = "started" | "busy" | "unavailable" | "no-window";

export interface GoalWindowRoundsDependencies<P> {
  newToken(): string;
  /** The screen is locked: a goal never starts a window-owned round then. */
  screenLocked(): boolean;
  /** Runs `run` after `ms`; returns a cancel. */
  setTimer(run: () => void, ms: number): () => void;
  /** A window-owned round lost its window: pause the goal, then stop the run. */
  closedMidRound(round: { chatId: string; streamId: string; documentId: string; payload: P }): void;
}

/** How long a window has to take an offered round before it runs without one. */
export const GOAL_WINDOW_ROUND_CLAIM_MS = 5_000;

interface Pending<P> {
  token: string;
  chatId: string;
  documentId: string;
  payload: P;
  resolve(result: GoalWindowRoundResult): void;
  cancelTimer(): void;
}

/** A round the window agreed to start: start it, then say how it went. */
export interface GoalWindowRoundClaim<P> {
  chatId: string;
  payload: P;
  /** Started with `streamId`, or not started. Resolves the offer. */
  settle(result: { kind: "started"; streamId: string } | { kind: "busy" | "unavailable" }): void;
}

export class GoalWindowRounds<P> {
  private readonly views = new Map<
    string,
    { document: GoalWindowDocument; view: GoalWindowView; at: number }
  >();
  private readonly pending = new Map<string, Pending<P>>();
  private readonly active = new Map<string, { chatId: string; streamId: string; payload: P }>();
  private clock = 0;

  constructor(private readonly deps: GoalWindowRoundsDependencies<P>) {}

  /** A document says what it shows. A round it owns ends if it now shows another chat. */
  report(document: GoalWindowDocument, view: GoalWindowView): void {
    this.views.set(document.documentId, { document, view, at: ++this.clock });
    for (const pending of [...this.pending.values()]) {
      if (pending.documentId === document.documentId && view.chatId !== pending.chatId)
        this.finish(pending, "no-window");
    }
    const round = this.active.get(document.documentId);
    if (round && view.chatId !== round.chatId) this.lose(document.documentId);
  }

  /** The document closed, reloaded or crashed. */
  gone(documentId: string): void {
    this.views.delete(documentId);
    for (const pending of [...this.pending.values()]) {
      if (pending.documentId === documentId) this.finish(pending, "no-window");
    }
    this.lose(documentId);
  }

  /**
   * Offers the chat's due round to a focused window that shows it. Resolves
   * `no-window` at once when there is none or the screen is locked, and when
   * the window declines or doesn't answer within the claim time.
   */
  offer(chatId: string, payload: P): Promise<GoalWindowRoundResult> {
    const target = this.target(chatId);
    if (!target) return Promise.resolve("no-window");
    return new Promise<GoalWindowRoundResult>((resolve) => {
      const token = this.deps.newToken();
      const pending: Pending<P> = {
        token,
        chatId,
        documentId: target.documentId,
        payload,
        resolve,
        cancelTimer: () => undefined,
      };
      this.pending.set(token, pending);
      pending.cancelTimer = this.deps.setTimer(
        () => this.finish(pending, "no-window"),
        GOAL_WINDOW_ROUND_CLAIM_MS,
      );
      try {
        target.send({ chatId, token });
      } catch {
        this.finish(pending, "no-window");
      }
    });
  }

  /** The window takes the round it was offered. Undefined when the offer is gone or was made to another document. */
  claim(token: string, documentId: string): GoalWindowRoundClaim<P> | undefined {
    const pending = this.pending.get(token);
    if (!pending || pending.documentId !== documentId) return undefined;
    this.pending.delete(token);
    pending.cancelTimer();
    let settled = false;
    return {
      chatId: pending.chatId,
      payload: pending.payload,
      settle: (result) => {
        if (settled) return;
        settled = true;
        if (result.kind === "started") {
          this.active.set(documentId, {
            chatId: pending.chatId,
            streamId: result.streamId,
            payload: pending.payload,
          });
          // The document went away, or showed another chat, while the round was starting.
          if (this.views.get(documentId)?.view.chatId !== pending.chatId) this.lose(documentId);
        }
        pending.resolve(result.kind);
      },
    };
  }

  /** The window can't take the round (it is busy or shows a draft): it runs without a window. */
  decline(token: string, documentId: string): void {
    const pending = this.pending.get(token);
    if (pending?.documentId === documentId) this.finish(pending, "no-window");
  }

  /** A run settled; a window-owned round with that stream is over. */
  settled(streamId: string): void {
    for (const [documentId, round] of this.active) {
      if (round.streamId === streamId) this.active.delete(documentId);
    }
  }

  private target(chatId: string): GoalWindowDocument | undefined {
    if (this.deps.screenLocked()) return undefined;
    let best: { document: GoalWindowDocument; at: number } | undefined;
    for (const entry of this.views.values()) {
      if (entry.view.chatId !== chatId || !entry.view.focused) continue;
      if (!best || entry.at > best.at) best = entry;
    }
    return best?.document;
  }

  private finish(pending: Pending<P>, result: GoalWindowRoundResult): void {
    if (this.pending.get(pending.token) !== pending) return;
    this.pending.delete(pending.token);
    pending.cancelTimer();
    pending.resolve(result);
  }

  private lose(documentId: string): void {
    const round = this.active.get(documentId);
    if (!round) return;
    this.active.delete(documentId);
    this.deps.closedMidRound({
      chatId: round.chatId,
      streamId: round.streamId,
      documentId,
      payload: round.payload,
    });
  }
}
