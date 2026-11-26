// A Bot's tool approvals and A–E question, shared by the Bot chat, a paired
// Mac's Bot chat and the bubble mini chat: the live list of waiting approvals,
// how identical waits share one card, the card itself, and the question as the
// quick-reply composer's prompt.

import * as React from "react";
import { ChatApprovalCard } from "../../components/chat-approval-card";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import { switchToAutoSuggestion, useSwitchToAutoOffer, type SwitchToAutoOffer } from "../../lib/switch-to-auto";
import { parseCommandReading } from "../../shared/command-reading";
import { BOT_APPROVAL_REPEAT_COUNT, botAlwaysAllowLabel } from "../../shared/tool-approval-scope";
import type { BotPendingQuestion } from "../../shared/bot-live";
import type { AskUserQuestionPromptV1 } from "../../shared/ask-user-question";
import type { BotApprovalPrompt } from "../../../main/services/bot-runtime/bot-approvals";

/** Tool approvals a Bot is waiting on, live: pushed prompts and withdrawals, plus a read on mount. */
export function useBotApprovals(botId: string | undefined, onWithdrawn?: (waitId: string) => void) {
  const [prompts, setPrompts] = React.useState<BotApprovalPrompt[]>([]);
  // Another Bot, or none (a bubbled chat stops listening): cards from before are stale,
  // so the list starts empty and is read again when a Bot is set.
  const [owner, setOwner] = React.useState(botId);
  if (owner !== botId) {
    setOwner(botId);
    setPrompts([]);
  }
  const withdrawn = React.useRef(onWithdrawn);
  withdrawn.current = onWithdrawn;
  const shown = React.useRef(prompts);
  shown.current = prompts;
  React.useEffect(() => {
    if (!botId) return;
    let active = true;
    void botsApi.pendingApprovals(botId).then((pending) => {
      if (active) setPrompts((current) => mergePrompts(current, pending));
    }).catch(() => undefined);
    const offPrompt = botsApi.onApproval((prompt) => {
      if (prompt.botId === botId) setPrompts((current) => mergePrompts(current, [prompt]));
    });
    const offSettled = botsApi.onApprovalSettled((settled) => {
      if (settled.botId === botId) {
        // Still shown here, so nobody answered it on this device: it went away (answered elsewhere, expired, the run ended).
        if (shown.current.some((prompt) => prompt.waitId === settled.waitId)) withdrawn.current?.(settled.waitId);
        setPrompts((current) => current.filter((prompt) => prompt.waitId !== settled.waitId));
      }
    });
    return () => {
      active = false;
      offPrompt();
      offSettled();
    };
  }, [botId]);
  const remove = React.useCallback(
    (waitId: string) => setPrompts((current) => current.filter((prompt) => prompt.waitId !== waitId)),
    [],
  );
  /** Puts a prompt back after its answer failed to send, so it can be answered again. */
  const restore = React.useCallback(
    (prompt: BotApprovalPrompt) => setPrompts((current) => mergePrompts(current, [prompt])),
    [],
  );
  return { prompts, remove, restore };
}

function mergePrompts(current: BotApprovalPrompt[], next: BotApprovalPrompt[]): BotApprovalPrompt[] {
  const byId = new Map(current.map((prompt) => [prompt.waitId, prompt] as const));
  for (const prompt of next) byId.set(prompt.waitId, prompt);
  return [...byId.values()];
}

/** Which shared card a pending approval belongs to: the same for every identical call, the wait itself otherwise. */
export function botApprovalGroupKey(prompt: BotApprovalPrompt): string {
  return prompt.argumentsHash && prompt.runHash
    ? JSON.stringify([prompt.botId, prompt.runHash, prompt.argumentsHash, prompt.toolName, prompt.summary, prompt.always?.key ?? null])
    : JSON.stringify(["wait", prompt.botId, prompt.waitId]);
}

/**
 * Identical pending approvals in one reply (same tool, card and exact
 * arguments) share one card. A wait without its arguments and run hashes is
 * never grouped: equal text is not the same action.
 */
export function groupBotApprovalPrompts(prompts: readonly BotApprovalPrompt[]): BotApprovalPrompt[][] {
  const groups = new Map<string, BotApprovalPrompt[]>();
  for (const prompt of prompts) {
    const key = botApprovalGroupKey(prompt);
    const group = groups.get(key);
    if (group) group.push(prompt);
    else groups.set(key, [prompt]);
  }
  return [...groups.values()];
}

/** A Bot's tool call that needs the person's yes or no before it runs: the shared approval card. */
export interface BotApprovalCardProps {
  name: string;
  prompt: BotApprovalPrompt;
  onAnswer(decision: "allow" | "deny", scope?: "always"): Promise<void> | void;
  /** Set when this device may only deny: where the person can allow it instead. */
  allowElsewhere?: string;
  /** ⌘↩ allows and ⌘⌫ denies while the message box is empty; only the first card takes them. */
  keyboardShortcuts?: boolean;
  /** Cards waiting in this chat, this one first. */
  pendingCount?: number;
  /**
   * Whether a repeated allow may offer switching this Mac to Auto (default on).
   * A window that can't change settings (the bubble overlay) turns it off, and
   * then never reads settings or providers for it.
   */
  offerAuto?: boolean;
}

export function BotApprovalCard({ offerAuto = true, ...props }: BotApprovalCardProps) {
  return offerAuto ? <BotApprovalCardWithAutoOffer {...props} /> : <BotApprovalCardView {...props} autoOffer={undefined} />;
}

function BotApprovalCardWithAutoOffer(props: Omit<BotApprovalCardProps, "offerAuto">) {
  const { prompt, allowElsewhere } = props;
  const repeated = prompt.always !== undefined && prompt.always.count >= BOT_APPROVAL_REPEAT_COUNT;
  const autoOffer = useSwitchToAutoOffer(repeated && prompt.autoWouldJudge === true && allowElsewhere === undefined);
  return <BotApprovalCardView {...props} autoOffer={autoOffer} />;
}

function BotApprovalCardView({
  name,
  prompt,
  onAnswer,
  allowElsewhere,
  keyboardShortcuts = false,
  pendingCount = 1,
  autoOffer,
}: Omit<BotApprovalCardProps, "offerAuto"> & { autoOffer: SwitchToAutoOffer | undefined }) {
  const [busy, setBusy] = React.useState(false);
  const inFlight = React.useRef(false);
  const [answerError, setAnswerError] = React.useState<string | null>(null);
  // Every eligible card offers Always; a count of 3 or more means it was
  // allowed again and again in the last 2 weeks. Then, in Ask, Auto is
  // offered beside Always, but only where main said Auto would hand this
  // call to the judge instead of a card. Not on a device that may only deny.
  const repeated = prompt.always !== undefined && prompt.always.count >= BOT_APPROVAL_REPEAT_COUNT;
  const respond = async (decision: "allow" | "deny", scope?: "always") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setAnswerError(null);
    try {
      await onAnswer(decision, scope);
    } catch (error) {
      setAnswerError(userFacingErrorMessage(error, "Aiden couldn’t send that answer."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <ChatApprovalCard
      pending={{
        approvalId: prompt.waitId,
        toolCallId: prompt.toolCallId,
        toolName: prompt.toolName,
        summary: prompt.summary,
        ...(prompt.always ? { scopes: ["once", "always"] } : {}),
        ...(() => {
          const reading = parseCommandReading(prompt.reading);
          return reading ? { reading } : {};
        })(),
      }}
      deciding={busy}
      onDecide={(decision, options) => void respond(decision, options?.scope === "always" ? "always" : undefined)}
      requester={name}
      alwaysOption={{ label: botAlwaysAllowLabel(name), hint: `${name} won’t ask again for this. Undo in Settings → Approvals.` }}
      notes={repeated ? [`You’ve allowed this ${prompt.always!.count} times in the last 2 weeks.`] : []}
      {...(autoOffer ? { suggestion: switchToAutoSuggestion(autoOffer) } : {})}
      {...(allowElsewhere ? { allowElsewhere } : {})}
      error={answerError}
      keyboardShortcuts={keyboardShortcuts}
      pendingCount={pendingCount}
    />
  );
}

/** The Bot's pending A–E question as the shared quick-reply composer's prompt. */
export function questionPrompt(question: BotPendingQuestion): AskUserQuestionPromptV1 {
  return {
    version: 1,
    promptId: question.waitId,
    streamId: "s-bot",
    toolCallId: question.toolCallId,
    questions: question.questions,
  };
}
