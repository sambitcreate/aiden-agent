// Aiden Live's tools for moving through Aiden's own window:
//
// - look_at_aiden reads the window's accessibility tree into a numbered list;
// - use_aiden acts on one numbered element with DOM events;
// - open_in_aiden jumps to a Settings destination through aidenAppNavigation.
//
// Guards are enforced here and in the page function, not only in Live's
// instructions: "you" controls are refused, "confirm" controls wait for the
// user's own spoken or tapped OK through the renderer, the renderer admits at
// most LIVE_APP_CONTROL_MAX_ACTIONS actions per request, and the user's own
// input in the window takes over at once.

import type { FunctionDeclaration } from "@google/genai";
import { AIDEN_APP_DESTINATIONS } from "../../aiden-app-navigation.js";
import {
  LIVE_APP_CONTROL_MAX_ACTIONS,
  LIVE_APP_CONTROL_RENDERER_TOOL,
} from "../../../../renderer/shared/live-app-control.js";
import {
  liveToolError,
  type LiveRendererToolBroker,
  type LiveToolCall,
  type LiveToolContext,
  type LiveToolProvider,
  type LiveToolResponse,
} from "../live-tools.js";
import {
  AIDEN_PAGE_ACTION_SOURCE,
  AIDEN_PAGE_KEYS,
  type AidenPageActionName,
  type AidenPageActionRequest,
  type AidenPageActionResult,
  type AidenPageKey,
} from "./page-action.js";
import {
  AIDEN_SCREEN_LIMITS,
  buildAidenScreen,
  type AidenScreen,
  type AidenScreenElement,
  type AidenScreenLimits,
  type CdpAxNode,
  type CdpDomSnapshot,
} from "./screen.js";

/** The DevTools protocol on Aiden's own window, attached lazily. */
export interface AidenWindowPort {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Called on every navigation of the window, including in-app route changes. */
  onNavigate(listener: () => void): () => void;
  close(): void;
}

/** Another debugger (DevTools) holds the window, so Live can't read it. */
export class AidenWindowInspectedError extends Error {
  constructor() {
    super("Aiden's window is being inspected.");
    this.name = "AidenWindowInspectedError";
  }
}

export type AidenAppPlace = (typeof AIDEN_APP_DESTINATIONS)[number];

export interface AidenAppControlOptions {
  port: AidenWindowPort;
  renderer: Pick<LiveRendererToolBroker, "request">;
  open(place: AidenAppPlace, signal: AbortSignal): Promise<{ status: "opened" | "blocked" | "unavailable" }>;
  /** Wait after an action before the fresh look, so the page can settle. */
  settleMs?: number;
  /** How long the outline stays after the last action. */
  idleMs?: number;
  /** Calls this provider takes per session, under Gemini's 256 tool-call ids. */
  sessionCalls?: number;
  /** After a confirmed action, the follow-up confirm button in its dialog needs no second OK for this long. */
  confirmGraceMs?: number;
  now?(): number;
}

const APP_CONTROL_ACTIONS: readonly AidenPageActionName[] = ["press", "type", "toggle", "select", "scroll", "key"];
const MAX_TEXT = 2_000;
const FRESH_LOOK_LIMITS: AidenScreenLimits = { elements: 120, characters: 8_000 };
const DEFAULT_SESSION_CALLS = 150;
const STOPPED_BY_USER = "taken_over";
const STOPPED_BY_INTERRUPT = "interrupted";
const CONFIRM_PAGE_CHANGED = "page_changed";

const PLACE_LABELS: Record<AidenAppPlace, string> = {
  appearance: "Appearance settings",
  memory: "Memory settings",
  limits: "Limits settings",
  skills: "Skills settings",
  providers: "Providers settings",
  "web-search": "Web Search settings",
};

export const AIDEN_APP_CONTROL_ERRORS = {
  userOnly: liveToolError("user_only", "Only the user can use this. Ask them to do it themselves."),
  stale: liveToolError("stale_element", "That number isn't on the latest look. Look again first."),
  gone: liveToolError("stale_element", "That element is gone. Look again first."),
  busy: liveToolError("busy", "Another action is still running. Wait for its result."),
  waiting: liveToolError("waiting_for_user", "Still waiting for the user's OK. Don't act until they answer."),
  takenOver: liveToolError("taken_over", "The user took over. Stop and wait until they ask again."),
  inspected: liveToolError(
    "window_inspected",
    "Aiden's window is being inspected in developer tools, so Live can't use it right now.",
  ),
  unreadable: liveToolError("window_unavailable", "Live couldn't read Aiden's window. Try again."),
  budget: liveToolError(
    "session_budget",
    "This Live session has used its moves through Aiden. Ask the user to restart Live to keep going.",
  ),
  invalid: liveToolError("invalid_arguments", "Those arguments don't fit this tool."),
  cancelled: liveToolError("cancelled", "The request was cancelled."),
} as const;

function stopped(abort: AbortController): LiveToolResponse {
  return abort.signal.reason === STOPPED_BY_USER ? AIDEN_APP_CONTROL_ERRORS.takenOver : AIDEN_APP_CONTROL_ERRORS.cancelled;
}

const PAGE_ERRORS: Partial<Record<AidenPageActionResult["status"], LiveToolResponse>> = {
  you: AIDEN_APP_CONTROL_ERRORS.userOnly,
  gone: AIDEN_APP_CONTROL_ERRORS.gone,
  disabled: liveToolError("disabled", "That control is turned off right now."),
  readonly: liveToolError("read_only", "That field can't be changed."),
  unsupported: liveToolError("unsupported", "That action doesn't work on this element. Try press."),
  no_option: liveToolError("no_option", "No option there has that name."),
};

export const AIDEN_APP_CONTROL_DECLARATIONS: readonly FunctionDeclaration[] = [
  {
    name: "look_at_aiden",
    description:
      "List what is on screen in Aiden's own window: headings for orientation and numbered controls with their state. Numbers last until the next look or a page change. Items marked (only you can use this) are for the user alone; never try them. Items marked (asks the user first) wait for the user's OK.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          maxLength: 80,
          description: "Optional words to look at first, such as a section, dialog or control name.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "use_aiden",
    description:
      "Act on one numbered element from the latest look in Aiden's window. press clicks it, type replaces a field's text with text, toggle flips a checkbox or switch, select picks an option by its name in text (or opens a list), scroll moves its area up, down, top or bottom (text), key sends one key. Returns what happened and a fresh look with new numbers.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        element: { type: "integer", minimum: 1, maximum: AIDEN_SCREEN_LIMITS.elements },
        action: { type: "string", enum: [...APP_CONTROL_ACTIONS] },
        text: { type: "string", maxLength: MAX_TEXT },
        key: { type: "string", enum: [...AIDEN_PAGE_KEYS] },
      },
      required: ["element", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "open_in_aiden",
    description: "Open a Settings page in Aiden's window, then return a fresh look of it.",
    parametersJsonSchema: {
      type: "object",
      properties: { place: { type: "string", enum: [...AIDEN_APP_DESTINATIONS] } },
      required: ["place"],
      additionalProperties: false,
    },
  },
];

export const AIDEN_APP_CONTROL_INSTRUCTIONS: readonly string[] = [
  "You can look at and move through Aiden's own window with look_at_aiden, use_aiden and open_in_aiden, but nothing outside Aiden.",
  "Look before acting and use numbers only from the latest look; use_aiden already returns a fresh look, so don't look again right after it.",
  "Never try anything marked (only you can use this); ask the user to do it. When use_aiden says it is waiting for the user's OK, don't repeat the call; Aiden tells you how to ask and what happened.",
  `Take at most ${LIVE_APP_CONTROL_MAX_ACTIONS} actions per request, stop when the user takes over, and never say something happened before the tool result says so.`,
];

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function quoted(name: string, role: string): string {
  return name ? `“${name}”` : `the ${role}`;
}

function actingLabel(action: AidenPageActionName, element: AidenScreenElement): string {
  const target = quoted(element.name, element.role);
  switch (action) {
    case "type":
      return `Typing in ${target}`;
    case "toggle":
      return `Switching ${target}`;
    case "select":
      return `Choosing in ${target}`;
    case "scroll":
      return `Scrolling ${target}`;
    case "key":
      return `Pressing a key in ${target}`;
    default:
      return `Pressing ${target}`;
  }
}

function confirmLabel(element: AidenScreenElement): string {
  const target = quoted(element.name, element.role);
  return element.dialog && element.dialog !== element.name ? `${element.dialog} — ${target}` : `Press ${target}`;
}

function outcome(action: AidenPageActionName, element: AidenScreenElement, result: AidenPageActionResult): string {
  const target = quoted(element.name, element.role);
  const done = result.status === "done" ? result : {};
  const state =
    "checked" in done && done.checked !== undefined
      ? done.checked === "mixed"
        ? " It is now partly checked."
        : done.checked
          ? " It is now on."
          : " It is now off."
      : "expanded" in done && done.expanded !== undefined
        ? done.expanded
          ? " It is now open."
          : " It is now closed."
        : "";
  switch (action) {
    case "type":
      return `Typed into ${target}.`;
    case "toggle":
      return `Switched ${target}.${state}`;
    case "select":
      return "opened" in done && done.opened ? `Opened ${target}; press the option you want.` : `Chose in ${target}.${state}`;
    case "scroll":
      return "moved" in done && done.moved === false ? `${target} didn't move further.` : `Scrolled ${target}.`;
    case "key":
      return `Sent the key to ${target}.${state}`;
    default:
      return `Pressed ${target}.${state}`;
  }
}

interface ParsedUse {
  element: number;
  request: AidenPageActionRequest;
}

function parseUse(args: Record<string, unknown>): ParsedUse | null {
  const element = args.element;
  const action = args.action;
  if (typeof element !== "number" || !Number.isInteger(element) || element < 1) return null;
  if (typeof action !== "string" || !APP_CONTROL_ACTIONS.includes(action as AidenPageActionName)) return null;
  const request: AidenPageActionRequest = { action: action as AidenPageActionName };
  if (args.text !== undefined) {
    if (typeof args.text !== "string" || args.text.length > MAX_TEXT) return null;
    request.text = args.text;
  }
  if (args.key !== undefined) {
    if (typeof args.key !== "string" || !(AIDEN_PAGE_KEYS as readonly string[]).includes(args.key)) return null;
    request.key = args.key as AidenPageKey;
  }
  if (request.action === "type" && request.text === undefined) return null;
  if (request.action === "key" && request.key === undefined) return null;
  return { element, request };
}

export class AidenAppControlProvider implements LiveToolProvider {
  readonly declarations = AIDEN_APP_CONTROL_DECLARATIONS;
  readonly instructions = AIDEN_APP_CONTROL_INSTRUCTIONS;

  private refs = new Map<number, AidenScreenElement>();
  private signatures: ReadonlySet<string> | undefined;
  private busy = false;
  private confirming = false;
  private current: AbortController | null = null;
  private watch: AbortController | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmGraceUntil = 0;
  /** The pending OK, bound to one element and one action; aborted when the page or look changes. */
  private pendingConfirm: AbortController | null = null;
  private calls = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly stopNavigation: () => void;

  constructor(private readonly options: AidenAppControlOptions) {
    // In-app route changes count: a number from before them could point anywhere.
    this.stopNavigation = options.port.onNavigate(() => {
      this.refs = new Map();
      this.confirmGraceUntil = 0;
      this.pendingConfirm?.abort(CONFIRM_PAGE_CHANGED);
    });
  }

  async handle(call: LiveToolCall, context: LiveToolContext): Promise<LiveToolResponse> {
    if (this.closed) return AIDEN_APP_CONTROL_ERRORS.unreadable;
    this.calls += 1;
    if (this.calls > (this.options.sessionCalls ?? DEFAULT_SESSION_CALLS)) return AIDEN_APP_CONTROL_ERRORS.budget;
    switch (call.name) {
      case "look_at_aiden":
        return this.handleLook(call.args, context.signal);
      case "use_aiden":
        return this.handleUse(call.args, context.signal);
      case "open_in_aiden":
        return this.handleOpen(call.args, context.signal);
      default:
        return liveToolError("tool_unavailable", "That tool is not available in this Live session.");
    }
  }

  /** Barge-in: stop what is running. A pending OK keeps waiting for the user's answer. */
  interrupt(): void {
    this.current?.abort(STOPPED_BY_INTERRUPT);
    this.endActing();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.current?.abort();
    this.lifetime.abort();
    this.endActing();
    this.stopNavigation();
    this.refs = new Map();
    try {
      this.options.port.close();
    } catch {
      // The window may already be gone.
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private portError(error: unknown): LiveToolResponse {
    return error instanceof AidenWindowInspectedError
      ? AIDEN_APP_CONTROL_ERRORS.inspected
      : AIDEN_APP_CONTROL_ERRORS.unreadable;
  }

  private async look(focus: string | undefined, limits: AidenScreenLimits, markNew: boolean): Promise<AidenScreen> {
    const port = this.options.port;
    const [ax, dom, metrics] = await Promise.all([
      port.call("Accessibility.getFullAXTree"),
      port.call("DOMSnapshot.captureSnapshot", { computedStyles: [] }),
      port.call("Page.getLayoutMetrics"),
    ]);
    const visual = record(record(metrics).cssVisualViewport);
    const layout = record(record(metrics).cssLayoutViewport);
    const number = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    const screen = buildAidenScreen({
      ax: record(ax) as { nodes?: CdpAxNode[] },
      dom: { documents: [], strings: [], ...(record(dom) as Partial<CdpDomSnapshot>) },
      viewport: {
        x: number(visual.pageX, number(layout.pageX, 0)),
        y: number(visual.pageY, number(layout.pageY, 0)),
        width: number(visual.clientWidth, number(layout.clientWidth, 0)),
        height: number(visual.clientHeight, number(layout.clientHeight, 0)),
      },
      focus,
      limits,
      previous: markNew ? this.signatures : undefined,
    });
    this.refs = new Map(screen.elements.map((element) => [element.ref, element]));
    this.signatures = screen.signatures;
    return screen;
  }

  private async handleLook(args: Record<string, unknown>, signal: AbortSignal): Promise<LiveToolResponse> {
    const focus = args.focus;
    if (focus !== undefined && (typeof focus !== "string" || focus.length > 80)) return AIDEN_APP_CONTROL_ERRORS.invalid;
    // A new look moves on: a pending OK and a follow-up grace no longer apply.
    this.confirmGraceUntil = 0;
    this.pendingConfirm?.abort(CONFIRM_PAGE_CHANGED);
    try {
      const screen = await this.look(focus, AIDEN_SCREEN_LIMITS, false);
      if (signal.aborted) return liveToolError("cancelled", "The request was cancelled.");
      return { ok: true, screen: screen.text };
    } catch (error) {
      return this.portError(error);
    }
  }

  /** Asks the renderer to count one action toward this request's limit. */
  private async admit(label: string, signal: AbortSignal): Promise<LiveToolResponse | null> {
    const answer = record(
      await this.options.renderer.request(LIVE_APP_CONTROL_RENDERER_TOOL, { op: "admit", label }, signal),
    );
    if (answer.ok === true) return null;
    const error = record(answer.error);
    if (error.code === "limit") {
      return liveToolError(
        "action_limit",
        `That's ${LIVE_APP_CONTROL_MAX_ACTIONS} actions for this request. Tell the user where things stand and wait for them.`,
      );
    }
    if (error.code === "taken_over") return AIDEN_APP_CONTROL_ERRORS.takenOver;
    return liveToolError("window_unavailable", "Aiden's window isn't ready for Live to act.");
  }

  /** Keeps the outline and the ribbon's acting state up while actions run. */
  private startActing(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.watch || this.closed) return;
    const watch = new AbortController();
    this.watch = watch;
    const ended = () => {
      if (this.watch === watch) this.watch = null;
    };
    void this.options.renderer
      .request(LIVE_APP_CONTROL_RENDERER_TOOL, { op: "watch" }, watch.signal)
      .then((answer) => {
        ended();
        if (record(answer).takenOver === true) this.takeOver();
        else if (!watch.signal.aborted && (this.busy || this.idleTimer)) this.startActing();
      }, ended);
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.busy) this.endActing();
    }, this.options.idleMs ?? 1_500);
  }

  private endActing(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const watch = this.watch;
    this.watch = null;
    watch?.abort();
  }

  /** The user's own input in the window: drop everything in flight. */
  private takeOver(): void {
    this.current?.abort(STOPPED_BY_USER);
    this.endActing();
  }

  private beginAction(signal: AbortSignal): AbortController {
    const abort = new AbortController();
    const forward = () => abort.abort();
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", forward, { once: true });
    abort.signal.addEventListener("abort", () => signal.removeEventListener("abort", forward), { once: true });
    this.busy = true;
    this.current = abort;
    return abort;
  }

  private finishAction(abort: AbortController): void {
    if (this.current === abort) this.current = null;
    this.busy = false;
    if (!abort.signal.aborted) this.scheduleIdle();
  }

  private async runPageAction(
    element: AidenScreenElement,
    request: AidenPageActionRequest,
    signal: AbortSignal,
  ): Promise<AidenPageActionResult> {
    const port = this.options.port;
    let objectId: string | undefined;
    try {
      const resolved = record(await port.call("DOM.resolveNode", { backendNodeId: element.backendNodeId }));
      objectId = typeof record(resolved.object).objectId === "string" ? (record(resolved.object).objectId as string) : undefined;
    } catch (error) {
      if (error instanceof AidenWindowInspectedError) throw error;
      return { status: "gone" };
    }
    if (!objectId) return { status: "gone" };
    try {
      // The user took over or interrupted while the element was found: don't act.
      if (signal.aborted) throw new Error("Stopped before acting.");
      const response = record(
        await port.call("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: AIDEN_PAGE_ACTION_SOURCE,
          arguments: [{ value: request }],
          returnByValue: true,
          userGesture: true,
        }),
      );
      if (response.exceptionDetails) throw new Error("The page action failed.");
      const value = record(record(response.result).value);
      return typeof value.status === "string" ? (value as AidenPageActionResult) : { status: "gone" };
    } finally {
      void port.call("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }

  private async handleUse(args: Record<string, unknown>, signal: AbortSignal): Promise<LiveToolResponse> {
    const parsed = parseUse(args);
    if (!parsed) return AIDEN_APP_CONTROL_ERRORS.invalid;
    if (this.confirming) return AIDEN_APP_CONTROL_ERRORS.waiting;
    if (this.busy) return AIDEN_APP_CONTROL_ERRORS.busy;
    const element = this.refs.get(parsed.element);
    if (!element) return AIDEN_APP_CONTROL_ERRORS.stale;
    if (element.guard === "you") return AIDEN_APP_CONTROL_ERRORS.userOnly;
    // A follow-up grace covers only the very next action.
    const graceUntil = this.confirmGraceUntil;
    this.confirmGraceUntil = 0;
    const abort = this.beginAction(signal);
    try {
      const refused = await this.admit(actingLabel(parsed.request.action, element), abort.signal);
      if (refused) return refused;
      if (abort.signal.aborted) return stopped(abort);
      this.startActing();
      let result = await this.runPageAction(element, parsed.request, abort.signal);
      if (result.status === "confirm" && result.inDialog && this.now() < graceUntil) {
        // The user already said yes to this; the dialog's own button follows it.
        result = await this.runPageAction(element, { ...parsed.request, confirmed: true }, abort.signal);
      }
      if (result.status === "confirm") {
        void this.confirmThenAct(element, parsed.request);
        return {
          ok: true,
          status: "waiting_for_user",
          message:
            "Waiting for the user's OK. Aiden tells you how to ask and what happened; don't repeat this call.",
        };
      }
      if (abort.signal.aborted) return stopped(abort);
      if (result.status !== "done") return PAGE_ERRORS[result.status] ?? AIDEN_APP_CONTROL_ERRORS.unreadable;
      const summary = outcome(parsed.request.action, element, result);
      await sleep(this.options.settleMs ?? 300, abort.signal);
      if (abort.signal.aborted) return { ok: true, result: summary };
      try {
        const screen = await this.look(undefined, FRESH_LOOK_LIMITS, true);
        return { ok: true, result: summary, screen: screen.text };
      } catch {
        this.refs = new Map();
        return { ok: true, result: `${summary} Look again before the next step.` };
      }
    } catch (error) {
      if (abort.signal.aborted) return stopped(abort);
      return this.portError(error);
    } finally {
      this.finishAction(abort);
    }
  }

  /** Waits for the user's spoken or tapped OK, then acts; Live hears the outcome as a note. */
  private async confirmThenAct(element: AidenScreenElement, request: AidenPageActionRequest): Promise<void> {
    this.confirming = true;
    this.endActing();
    const pending = new AbortController();
    const endWithSession = () => pending.abort();
    this.lifetime.signal.addEventListener("abort", endWithSession, { once: true });
    this.pendingConfirm = pending;
    let answer: Record<string, unknown>;
    try {
      answer = record(
        await this.options.renderer.request(
          LIVE_APP_CONTROL_RENDERER_TOOL,
          { op: "confirm", label: confirmLabel(element) },
          pending.signal,
        ),
      );
    } catch {
      answer = {};
    } finally {
      this.confirming = false;
      if (this.pendingConfirm === pending) this.pendingConfirm = null;
      this.lifetime.signal.removeEventListener("abort", endWithSession);
    }
    if (this.closed) return;
    // Whatever happens next, the page is about to change under the old numbers.
    this.refs = new Map();
    if (pending.signal.aborted || answer.ok !== true || answer.confirmed !== true) {
      const reason =
        pending.signal.reason === CONFIRM_PAGE_CHANGED
          ? "The page changed before the user answered"
          : answer.reason === "timeout"
            ? "The user didn't answer in time"
            : "The user didn't confirm";
      await this.note(`${reason}, so ${quoted(element.name, element.role)} was not used. Nothing changed.`);
      return;
    }
    const abort = this.beginAction(this.lifetime.signal);
    let message: string;
    try {
      this.startActing();
      const result = await this.runPageAction(element, { ...request, confirmed: true }, abort.signal);
      if (result.status === "done") {
        this.confirmGraceUntil = this.now() + (this.options.confirmGraceMs ?? 15_000);
        message = `The user confirmed. ${outcome(request.action, element, result)} Look again before the next step.`;
      } else if (abort.signal.aborted) {
        message = "The user took over, so the confirmed action didn't run.";
      } else {
        message = `The user confirmed, but ${quoted(element.name, element.role)} couldn't be used. Look again.`;
      }
    } catch {
      message = abort.signal.aborted
        ? "The user took over, so the confirmed action didn't run."
        : "The user confirmed, but Live couldn't reach Aiden's window. Look again.";
    } finally {
      this.finishAction(abort);
    }
    await this.note(message);
  }

  private async note(text: string): Promise<void> {
    if (this.closed) return;
    await this.options.renderer
      .request(LIVE_APP_CONTROL_RENDERER_TOOL, { op: "note", text }, this.lifetime.signal)
      .catch(() => undefined);
  }

  private async handleOpen(args: Record<string, unknown>, signal: AbortSignal): Promise<LiveToolResponse> {
    const place = args.place;
    if (typeof place !== "string" || !(AIDEN_APP_DESTINATIONS as readonly string[]).includes(place)) {
      return AIDEN_APP_CONTROL_ERRORS.invalid;
    }
    if (this.confirming) return AIDEN_APP_CONTROL_ERRORS.waiting;
    if (this.busy) return AIDEN_APP_CONTROL_ERRORS.busy;
    this.confirmGraceUntil = 0;
    const target = place as AidenAppPlace;
    const abort = this.beginAction(signal);
    try {
      const refused = await this.admit(`Opening ${PLACE_LABELS[target]}`, abort.signal);
      if (refused) return refused;
      if (abort.signal.aborted) return stopped(abort);
      this.startActing();
      const opened = await this.options.open(target, abort.signal);
      if (abort.signal.aborted) return stopped(abort);
      if (opened.status === "blocked") {
        return liveToolError("blocked", "Aiden can't open that right now; setup or a dialog is in the way.");
      }
      if (opened.status !== "opened") return liveToolError("unavailable", "Aiden couldn't open that place.");
      this.refs = new Map();
      await sleep(this.options.settleMs ?? 300, abort.signal);
      try {
        const screen = await this.look(undefined, FRESH_LOOK_LIMITS, false);
        return { ok: true, result: `Opened ${PLACE_LABELS[target]}.`, screen: screen.text };
      } catch {
        return { ok: true, result: `Opened ${PLACE_LABELS[target]}. Look before the next step.` };
      }
    } catch {
      return abort.signal.aborted ? stopped(abort) : AIDEN_APP_CONTROL_ERRORS.unreadable;
    } finally {
      this.finishAction(abort);
    }
  }
}
