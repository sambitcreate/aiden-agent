import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { botsApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { addBotToCache } from "../main/bots/bot-identity";
import type { BotDefinition } from "../shared/bots";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../shared/bot-capabilities";
import { BotAvatar } from "./bot-avatar";
import { Button, Text } from "./ui";

type FirstBotState = { kind: "making" } | { kind: "ready"; bot: BotDefinition } | { kind: "failed" };

/**
 * The first Bot (docs/plans/bot-ux-simplification.md §4.1). Onboarding makes it
 * silently, "Chief" with a random look and no job yet, and hands over to its
 * chat: it opens when setup finishes and its first message asks what it should
 * help with. Making it is idempotent in main, so showing this twice, or
 * running onboarding again, never makes a second one. Like New bot, making it
 * with Full access accepts the access notice first, or the Bot could not act.
 * A failure offers only Try again.
 */
export function OnboardingBotsStep({ onReady, onBusyChange }: { onReady(bot: BotDefinition): void; onBusyChange?(busy: boolean): void }) {
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
      const { notice } = await botsApi.getCapabilityCatalog();
      if (notice.requiresAcknowledgement || notice.acceptedDecision !== "continue_full") {
        await botsApi.acknowledgeAccessNotice({
          version: BOT_FULL_ACCESS_NOTICE_VERSION,
          decision: "continue_full",
          confirmedForeground: true,
        });
      }
      const { bot } = await botsApi.createFirst();
      addBotToCache(qc, bot);
      void qc.invalidateQueries({ queryKey: queryKeys.bots });
      setState({ kind: "ready", bot });
      onReadyRef.current(bot);
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
        {state.kind === "failed" ? (
          <Button className="mt-2" size="small" variant="filled" onClick={() => void make()}>
            Try again
          </Button>
        ) : null}
      </div>
    </section>
  );
}
