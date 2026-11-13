import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { botsApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { addBotToCache } from "../main/bots/bot-identity";
import type { BotDefinition } from "../shared/bots";
import { BotAvatar } from "./bot-avatar";
import { Button, Text } from "./ui";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../shared/bot-capabilities";

/**
 * How the first Bot may act once setup finishes: Full access, accepted when
 * the person presses Start using Aiden (or already accepted); or the person
 * chose earlier to review access first, which stands.
 */
export type FirstBotAccess = "full" | "review_first";

type FirstBotState =
  | { kind: "making" }
  | { kind: "ready"; bot: BotDefinition; access: FirstBotAccess }
  | { kind: "failed" };

/**
 * The first Bot (docs/plans/bot-ux-simplification.md §4.1). Onboarding makes it
 * silently, "Chief" with a random look and no job yet, and hands over to its
 * chat: it opens when setup finishes and its first message asks what it should
 * help with. Making it is idempotent in main, so showing this twice, or
 * running onboarding again, never makes a second one. It says the Bot has Full
 * access; nothing is accepted here. Pressing Start using Aiden accepts it
 * (`acceptFirstBotAccess`), and an earlier choice to review access first is
 * kept. A failure offers only Try again.
 */
export function OnboardingBotsStep({
  onReady,
  onBusyChange,
}: {
  onReady(bot: BotDefinition, access: FirstBotAccess): void;
  onBusyChange?(busy: boolean): void;
}) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<FirstBotState>({ kind: "making" });
  const onReadyRef = React.useRef(onReady);
  onReadyRef.current = onReady;
  const onBusyRef = React.useRef(onBusyChange);
  onBusyRef.current = onBusyChange;
  const make = React.useCallback(async () => {
    setState({ kind: "making" });
    onBusyRef.current?.(true);
    try {
      // The notice only picks the card's words: main keeps a review-first
      // choice when Start accepts, so an unreadable notice never fails the step.
      const [{ bot }, notice] = await Promise.all([
        botsApi.createFirst(),
        botsApi.getAccessNotice().catch(() => null),
      ]);
      const access: FirstBotAccess =
        notice && !notice.requiresAcknowledgement && notice.acceptedDecision === "customize_first" ? "review_first" : "full";
      addBotToCache(qc, bot);
      void qc.invalidateQueries({ queryKey: queryKeys.bots });
      setState({ kind: "ready", bot, access });
      onReadyRef.current(bot, access);
    } catch {
      setState({ kind: "failed" });
    } finally {
      onBusyRef.current?.(false);
    }
  }, [qc]);
  React.useEffect(() => {
    void make();
  }, [make]);

  return (
    <section aria-label="Your first Bot" className="settings-card mt-4 flex items-start gap-3 px-4 py-3" data-onboarding-first-bot={state.kind}>
      {state.kind === "ready" ? (
        <BotAvatar avatar={state.bot.avatar} name={state.bot.name} size="medium" />
      ) : (
        <span aria-hidden="true" className="size-9 shrink-0 rounded-card bg-control motion-safe:animate-pulse" />
      )}
      <div className="min-w-0 flex-1">
        <Text as="p" variant="small-strong" role="status">
          {state.kind === "ready"
            ? `${state.bot.name} is ready`
            : state.kind === "failed"
              ? "Your first Bot isn’t ready yet"
              : "Making your first Bot…"}
        </Text>
        <Text as="p" variant="small" color="secondary" className="mt-0.5 text-pretty">
          A Bot is a helper with its own chat, memory and routines.
          {state.kind === "ready" ? ` Its chat opens when you finish, and it will ask what you’d like help with.` : ""}
        </Text>
        {state.kind === "ready" ? (
          <Text as="p" variant="small" color="secondary" className="mt-1.5 text-pretty">
            {state.access === "full"
              ? `${state.bot.name} gets Full access: it can use your files, apps and the web as you can, and still asks before anything risky. Starting accepts this; you can narrow it any time in ${state.bot.name}’s Advanced tab.`
              : `You chose to review a Bot’s access first, so ${state.bot.name} waits until you set it in its Advanced tab.`}
          </Text>
        ) : null}
        {state.kind === "failed" ? (
          <Button className="mt-2" size="small" variant="filled" onClick={() => void make()}>
            Try again
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Start using Aiden, pressed: the person accepts the first Bot's Full access,
 * and the Bot then introduces itself. A choice to review access first is left
 * as it is, and that Bot doesn't introduce itself until its access is set.
 */
export async function acceptFirstBotAccess(botId: string, access: FirstBotAccess): Promise<void> {
  if (access !== "full") return;
  // Main checks for a review-first choice and accepts in one step, so one made
  // since this step showed still stands.
  const notice = await botsApi.acceptFirstBotAccess({
    version: BOT_FULL_ACCESS_NOTICE_VERSION,
    decision: "continue_full",
    confirmedForeground: true,
  });
  if (notice.requiresAcknowledgement || notice.acceptedDecision !== "continue_full") return;
  await botsApi.introduce(botId);
}
