import * as React from "react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { LayoutTemplate, Plus, RotateCcw } from "lucide-react";
import { Button, Callout, EmptyState, ScrollArea, Text } from "../components/ui";
import { botChatPath, botListLocation } from "../lib/bot-routes";
import { settingsLocation } from "../lib/settings-section";
import { lastViewedBotId } from "../lib/bot-sidebar-preferences";
import { useBot } from "../lib/queries";
import type { BotDefinition } from "../shared/bots";
import { BotLearningPage } from "./bots/bot-learning-page";
import { BotCreateMenu, useBotCreateDialogs } from "./bots/bot-create-menu";
import { useBotRows } from "./bots/bot-sidebar-rows";
import { BotOpenWorkPage } from "./bots/bot-open-work-page";
import { BotPageShell, BotPageSkeleton } from "./bots/bot-page-shell";
import { botPageTarget, parseBotPageSearch, type BotPageTarget } from "./bots/bot-page-search";
import { useBotPanelActions } from "./bots/bot-panel-context";
import { useBotSidebarPreferences } from "./bots/use-bot-sidebar-preferences";

/** How long /bots waits for chat-activity summaries before ordering Bots by their own updatedAt. */
const SUMMARIES_GRACE_MS = 800;
/** How recent a cached Bots list must be for /bots to open the last viewed Bot from it while it refreshes. */
const CACHED_LIST_TRUST_MS = 5 * 60 * 1000;

/**
 * `/bots` with no Bot selected (spec §9): the Bot list lives in the sidebar, so
 * this opens the chat of the Bot last viewed on this Mac, else the one with the
 * newest activity. With no Bots it points at New bot and Templates.
 */
function BotsIndex() {
  const navigate = useNavigate();
  const { bots, rows, summariesSettled } = useBotRows();
  const { preferences } = useBotSidebarPreferences();
  const [summariesGraceOver, setSummariesGraceOver] = React.useState(false);
  const openChat = (bot: BotDefinition) => void navigate(botChatPath(bot.id));
  const create = useBotCreateDialogs(openChat);
  const creating = create.creating || create.templates;
  // A settled, successful load names a Bot to open. A list read recently enough
  // (this launch's own read, refreshing in the background) may name the Bot the
  // person last looked at without waiting: that Bot's chat shows at once from
  // the cache, and a Bot deleted elsewhere since would say so on its page.
  const settled = bots.isSuccess && !bots.isFetching;
  const freshEnough = bots.isSuccess && Date.now() - bots.dataUpdatedAt < CACHED_LIST_TRUST_MS;
  const hasBots = bots.isSuccess && bots.data.length > 0;
  const target = React.useMemo(() => {
    if (bots.data === undefined || bots.data.length === 0) return null;
    const viewed = lastViewedBotId(preferences, new Set(bots.data.map((bot) => bot.id)));
    if (viewed && (settled || freshEnough)) return viewed;
    if (!settled) return null;
    // Rows are ordered by chat activity once the summaries are in, else by the Bot's own
    // updatedAt; a summary that never answers must not keep /bots blank.
    return summariesSettled || summariesGraceOver ? (rows[0]?.bot.id ?? null) : null;
  }, [bots.data, freshEnough, preferences, rows, settled, summariesGraceOver, summariesSettled]);

  React.useEffect(() => {
    if (!settled || summariesSettled) return;
    const timer = setTimeout(() => setSummariesGraceOver(true), SUMMARIES_GRACE_MS);
    return () => clearTimeout(timer);
  }, [settled, summariesSettled]);

  React.useEffect(() => {
    // While the create flow is open it finishes first and opens the new Bot itself.
    if (target && !creating) void navigate({ ...botChatPath(target), replace: true });
  }, [creating, navigate, target]);

  if (hasBots && !creating) {
    return (
      <main className="mx-auto h-full w-full max-w-3xl px-5 pt-4">
        <BotPageSkeleton label="Opening your Bot" groups={[3]} />
      </main>
    );
  }
  return (
    <ScrollArea
      scrollRestorationId="bots-home"
      title="Bots"
      actions={<BotCreateMenu variant="toolbar" onNewBot={create.newBot} onTemplates={create.openTemplates} />}
    >
      <main className="mx-auto w-full max-w-3xl px-5 pb-10 pt-4">
        {bots.isError ? (
          <Callout color="red" role="alert" className="flex-row items-center justify-between gap-4">
            <div>
              <Text variant="small-strong" color="red">
                Your Bots couldn’t be loaded
              </Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5">
                Check that Aiden finished starting, then try again.
              </Text>
            </div>
            <Button size="small" variant="filled" onClick={() => void bots.refetch()}>
              <RotateCcw /> Try again
            </Button>
          </Callout>
        ) : bots.isLoading ? (
          <BotPageSkeleton label="Loading Bots" groups={[3]} />
        ) : (
          <EmptyState
            title="No Bots yet"
            description="A Bot is a helper with its own chat, memory and routines. Name one and tell it what you need, or start from a template."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="accent" onClick={create.newBot}>
                  <Plus /> New bot
                </Button>
                <Button variant="filled" onClick={create.openTemplates}>
                  <LayoutTemplate /> Templates
                </Button>
              </div>
            }
          />
        )}
      </main>
      {create.dialogs}
    </ScrollArea>
  );
}

function BotPage({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const panel = useBotPanelActions();
  const bot = useBot(botId);
  const target = botPageTarget(parseBotPageSearch(useSearch({ strict: false }) as Record<string, unknown>).page);
  const targetKey = JSON.stringify(target);
  // The Profile and Advanced pages are gone: their links open the Bot's chat
  // with its settings in the side panel.
  React.useEffect(() => {
    const next = JSON.parse(targetKey) as BotPageTarget;
    if (next.kind === "settings") {
      void navigate({ ...settingsLocation(next.section), replace: true });
    } else if (next.kind === "panel") {
      panel.show(next.tab, next.section ? { botId, section: next.section } : { botId });
      void navigate({ ...botChatPath(botId), replace: true });
    }
  }, [botId, navigate, panel, targetKey]);
  const allBots = () => void navigate(botListLocation());
  // Back from Open work or What I've learned: the chat, with the settings they were opened from.
  const backToSettings = () => {
    panel.show("advanced", { botId });
    void navigate(botChatPath(botId));
  };

  if (target.kind !== "page" || bot.isLoading) {
    return (
      <BotPageShell scrollId={`bot-page:${botId}`} title="" backLabel="All Bots" onBack={allBots}>
        <BotPageSkeleton label="Loading Bot" groups={[3, 2]} />
      </BotPageShell>
    );
  }
  if (!bot.data) {
    return (
      <BotPageShell scrollId={`bot-page:${botId}`} title="Bot" backLabel="All Bots" onBack={allBots}>
        <EmptyState
          title="Bot not found"
          description="This Bot may have been deleted."
          action={
            <Button variant="filled" onClick={allBots}>
              All Bots
            </Button>
          }
        />
      </BotPageShell>
    );
  }
  const current = bot.data;
  return target.page === "open-work" ? (
    <BotOpenWorkPage key={`${current.id}:open-work`} bot={current} onClose={backToSettings} />
  ) : (
    <BotLearningPage key={`${current.id}:learning`} bot={current} onClose={backToSettings} />
  );
}

/** Routes `/bots` to the most recent Bot's chat (or New bot and Templates), and `/bots/$botId` to a Bot's Open work or What I've learned, or (old links) its chat with its settings beside it. */
export function BotsView() {
  const params = useParams({ strict: false }) as { botId?: string };
  if (params.botId) return <BotPage botId={params.botId} />;
  return <BotsIndex />;
}
