// Answering the open chat's tool approvals by voice during Aiden Live.
//
// The chat pane publishes its pending approvals and its own decide function
// (the one the card's buttons call) to `liveChatApprovals`. While a Live
// session is on and the setting allows it, `LiveChatVoiceApprovals` takes the
// first approval of the chat on screen, has Live read it out, shows it on the
// floating ribbon, and answers it when the user's own finalized speech, after
// the read-out, is exactly an allow or deny phrase. Voice allow is always
// "allow once". Live's own words and model tool calls never reach this path.

import type { ApprovalPrompt } from "./ipc";
import { liveActivity, type LiveActivity } from "./live-activity";
import { liveOpenChat, type LiveOpenChatSnapshot } from "./live-open-chat";
import { liveSessionBus, type LiveVoiceInput } from "./live-session-bus";
import { matchLiveVoicePhrase } from "../shared/live-voice-phrases";
import { aidenLivePreferences, type AidenLiveSettingsFields } from "../shared/aiden-live-settings";

export type LiveChatApprovalDecide = (
  prompt: ApprovalPrompt,
  decision: "allow" | "deny",
) => Promise<void> | void;

/** What the chat pane on screen is waiting on, in the order its card shows them. */
export interface LiveChatApprovalsSnapshot {
  chatId: string;
  approvals: readonly ApprovalPrompt[];
  /** The chat pane's own answer path: the same call as tapping Deny or Allow once. */
  decide: LiveChatApprovalDecide;
}

type Listener = () => void;

export class LiveChatApprovalsStore {
  private snapshot: LiveChatApprovalsSnapshot | null = null;
  private owner: symbol | null = null;
  private readonly listeners = new Set<Listener>();

  publish(owner: symbol, snapshot: LiveChatApprovalsSnapshot): void {
    this.owner = owner;
    const previous = this.snapshot;
    if (
      previous &&
      previous.chatId === snapshot.chatId &&
      previous.decide === snapshot.decide &&
      sameApprovals(previous.approvals, snapshot.approvals)
    ) {
      return;
    }
    this.snapshot = { ...snapshot, approvals: [...snapshot.approvals] };
    this.emit();
  }

  /** Clears the snapshot only if this owner published it last. */
  clear(owner: symbol): void {
    if (this.owner !== owner) return;
    this.owner = null;
    if (this.snapshot === null) return;
    this.snapshot = null;
    this.emit();
  }

  get(): LiveChatApprovalsSnapshot | null {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function sameApprovals(a: readonly ApprovalPrompt[], b: readonly ApprovalPrompt[]): boolean {
  return a.length === b.length && a.every((prompt, index) => prompt.approvalId === b[index]?.approvalId);
}

export const liveChatApprovals = new LiveChatApprovalsStore();

// ── What Live says, and whether speech may answer ─────────────────────────

/**
 * Plain workspace tools whose card offers Allow once. Anything else (MCP and
 * browser actions, image generation that may cost money, Computer Use,
 * schedules, helpers, form fill) needs a tap.
 */
const VOICE_ANSWERABLE_TOOLS: ReadonlySet<string> = new Set([
  "run_command",
  "background_job",
  "edit_file",
  "write_file",
  "read_file",
  "delete_file",
  "move_file",
  "share_image",
  "web_fetch",
]);

/** Words that suggest passwords, keys, money or handing a step to the person. */
const SENSITIVE_WORDS =
  /\b(?:pass(?:word|phrase|code|key)s?|credentials?|secrets?|api[ _-]?keys?|tokens?|keychain|2fa|otp|payments?|pay|credit[ -]?cards?|checkout|purchase|buy|billing|bank|wallet|transfer|hand[ -]?off)\b/iu;

const SPOKEN_LIMIT = 80;

/** One line, no control or direction marks, clipped for speech. */
export function liveSpokenText(value: string, limit = SPOKEN_LIMIT): string {
  const line = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩“”"]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function baseName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

function summaryAfter(summary: string, prefix: string): string | undefined {
  if (!summary.startsWith(prefix)) return undefined;
  const rest = summary.slice(prefix.length).split("\n")[0]?.trim();
  return rest ? rest : undefined;
}

/** What the chat wants to do, as the end of "wants to …": "run npm test". */
export function liveApprovalAction(prompt: Pick<ApprovalPrompt, "toolName" | "summary" | "preview" | "details">): string {
  const command =
    prompt.preview?.kind === "command"
      ? prompt.preview.command
      : summaryAfter(prompt.summary, "Run command: ") ?? summaryAfter(prompt.summary, "Run in the background: ");
  const path =
    prompt.preview?.kind === "file"
      ? prompt.preview.path
      : summaryAfter(prompt.summary, "Edit file: ") ?? summaryAfter(prompt.summary, "Create or replace file: ");
  if (prompt.details === undefined) {
    switch (prompt.toolName) {
      case "run_command":
        if (command) return `run ${liveSpokenText(command)}`;
        return "run a command";
      case "background_job":
        if (command) return `run ${liveSpokenText(command)} in the background`;
        return "run a command in the background";
      case "edit_file":
        return path ? `edit ${liveSpokenText(baseName(path))}` : "edit a file";
      case "write_file":
        return path ? `write ${liveSpokenText(baseName(path))}` : "write a file";
      case "read_file":
        return "read a file";
      case "delete_file":
        return "delete a file";
      case "move_file":
        return "move a file";
      case "web_fetch":
        return "open a web page";
      case "share_image":
        return "share an image in the chat";
      case "generate_image":
        return "generate an image";
    }
  }
  const kind = (prompt.details as { kind?: unknown } | undefined)?.kind;
  if (kind === "scheduled-task" || kind === "assistant-automation") return "save a scheduled task";
  if (kind === "form-fill-batch") return "fill in a form";
  if (kind === "computer-use-access") return "use your computer";
  if (prompt.toolName === "computer_use") return "use your computer";
  const words = prompt.toolName.replace(/[_-]+/gu, " ").trim();
  return words ? `use ${liveSpokenText(words, 40)}` : "use a tool";
}

/** Whether speech may answer this approval; false means tap only. */
export function liveApprovalVoiceAnswerable(
  prompt: Pick<ApprovalPrompt, "toolName" | "summary" | "preview" | "details" | "canAllow" | "scopes">,
): boolean {
  if (prompt.canAllow === false) return false;
  if (prompt.details !== undefined) return false;
  if (Array.isArray(prompt.scopes) && !prompt.scopes.includes("once")) return false;
  if (!VOICE_ANSWERABLE_TOOLS.has(prompt.toolName)) return false;
  const text = [
    prompt.summary,
    prompt.preview?.kind === "command" ? prompt.preview.command : "",
    prompt.preview?.kind === "file" ? prompt.preview.path : "",
  ].join("\n");
  return !SENSITIVE_WORDS.test(text);
}

function sentenceCase(text: string): string {
  return text ? `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}` : text;
}

export function liveApprovalReadOut(chatTitle: string, action: string, voice: boolean): string {
  return `Tell the user: The chat “${liveSpokenText(chatTitle, 60)}” wants to ${action}. ${
    voice ? "Say allow or deny." : "This one needs a tap."
  }`;
}

export function liveApprovalWaitingElsewhere(chatTitle: string): string {
  return `Tell the user: The chat “${liveSpokenText(chatTitle, 60)}” is still waiting for an approval. Open it to answer.`;
}

// ── The controller ────────────────────────────────────────────────────────

export interface LiveChatVoiceApprovalsDependencies {
  bus: {
    currentSessionId(): string | null;
    onSession(listener: (sessionId: string | null) => void): () => void;
    onVoiceInput(listener: (input: LiveVoiceInput) => void): () => void;
    latestVoiceInputId(): number;
    note(text: string): Promise<boolean>;
  };
  openChat: { get(): LiveOpenChatSnapshot | null; subscribe(listener: Listener): () => void };
  approvals: Pick<LiveChatApprovalsStore, "get" | "subscribe">;
  activity: { set(source: string, activity: LiveActivity | null): void };
}

export type LiveApprovalVoiceHint = "voice" | "tap";

interface CurrentApproval {
  prompt: ApprovalPrompt;
  chatId: string;
  chatTitle: string;
  voice: boolean;
  /** Only speech with a larger id than this, captured at the read-out, counts. */
  baseline: number;
  answering: boolean;
}

/** The ribbon source this feature publishes under. */
export const LIVE_APPROVALS_ACTIVITY_SOURCE = "approvals";

export class LiveChatVoiceApprovals {
  private enabled = false;
  private current: CurrentApproval | null = null;
  private starts = 0;
  private stopListening: (() => void) | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly deps: LiveChatVoiceApprovalsDependencies) {}

  /** Settings → Aiden Live → Answer approvals by voice. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.sync();
  }

  /** Starts listening; the returned function stops this start. */
  start(): () => void {
    this.starts += 1;
    if (this.starts === 1) {
      const sync = () => this.sync();
      const removers = [
        this.deps.bus.onSession(sync),
        this.deps.bus.onVoiceInput((input) => this.hear(input)),
        this.deps.openChat.subscribe(sync),
        this.deps.approvals.subscribe(sync),
      ];
      this.stopListening = () => removers.forEach((remove) => remove());
      this.sync();
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.starts -= 1;
      if (this.starts > 0) return;
      this.stopListening?.();
      this.stopListening = null;
      this.replace(null);
    };
  }

  /** How the approval with this id can be answered right now, or null when Live is not on it. */
  voiceHint(approvalId: string | undefined): LiveApprovalVoiceHint | null {
    const current = this.current;
    if (!current || !approvalId || current.prompt.approvalId !== approvalId) return null;
    return current.voice ? "voice" : "tap";
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The approval Live may answer now: the first one of the chat on screen. */
  private head(): { prompt: ApprovalPrompt; chatId: string; chatTitle: string } | null {
    if (!this.enabled || this.starts === 0 || this.deps.bus.currentSessionId() === null) return null;
    const open = this.deps.openChat.get();
    const published = this.deps.approvals.get();
    if (!open || !published || published.chatId !== open.chatId) return null;
    const prompt = published.approvals[0];
    return prompt ? { prompt, chatId: open.chatId, chatTitle: open.title } : null;
  }

  private sync(): void {
    const head = this.head();
    const previous = this.current;
    if (previous && head && previous.prompt.approvalId === head.prompt.approvalId && previous.chatId === head.chatId) {
      return;
    }
    if (previous) this.replace(null);
    if (previous && !head) this.mentionIfLeftWaiting(previous);
    if (!head) return;
    const voice = liveApprovalVoiceAnswerable(head.prompt);
    const next: CurrentApproval = {
      ...head,
      voice,
      baseline: this.deps.bus.latestVoiceInputId(),
      answering: false,
    };
    this.replace(next);
    void this.deps.bus.note(liveApprovalReadOut(head.chatTitle, liveApprovalAction(head.prompt), voice));
  }

  /** The approval is still pending in a chat the user moved away from. */
  private mentionIfLeftWaiting(previous: CurrentApproval): void {
    if (!this.enabled || this.deps.bus.currentSessionId() === null) return;
    const open = this.deps.openChat.get();
    const published = this.deps.approvals.get();
    const stillHere = open?.chatId === previous.chatId && published?.chatId === previous.chatId;
    if (stillHere) return;
    void this.deps.bus.note(liveApprovalWaitingElsewhere(previous.chatTitle));
  }

  private replace(next: CurrentApproval | null): void {
    this.current = next;
    this.deps.activity.set(
      LIVE_APPROVALS_ACTIVITY_SOURCE,
      next
        ? {
            kind: "approval",
            id: next.prompt.approvalId,
            title: sentenceCase(liveApprovalAction(next.prompt)),
            chatTitle: next.chatTitle,
            voice: next.voice,
            allow: () => void this.answer(next, "allow"),
            deny: () => void this.answer(next, "deny"),
          }
        : null,
    );
    for (const listener of [...this.listeners]) listener();
  }

  private hear(input: LiveVoiceInput): void {
    const current = this.current;
    if (!current || !current.voice || current.answering || input.id <= current.baseline) return;
    const phrase = matchLiveVoicePhrase(input.text);
    if (phrase?.kind !== "allow" && phrase?.kind !== "deny") return;
    void this.answer(current, phrase.kind);
  }

  /** Voice and ribbon taps both end in the chat pane's own decide. */
  private async answer(target: CurrentApproval, decision: "allow" | "deny"): Promise<void> {
    if (this.current !== target || target.answering) return;
    const head = this.head();
    const published = this.deps.approvals.get();
    if (!head || head.prompt.approvalId !== target.prompt.approvalId || !published) return;
    target.answering = true;
    try {
      await published.decide(target.prompt, decision);
    } catch {
      // The chat pane reports its own failures.
    } finally {
      target.answering = false;
    }
  }
}

export const liveChatVoiceApprovals = new LiveChatVoiceApprovals({
  bus: liveSessionBus,
  openChat: liveOpenChat,
  approvals: liveChatApprovals,
  activity: liveActivity,
});

/** Whether the stored settings let approvals be answered by voice; off until settings load. */
export function liveVoiceApprovalsEnabled(settings: AidenLiveSettingsFields | null | undefined): boolean {
  return settings != null && aidenLivePreferences(settings).voiceApprovals;
}
