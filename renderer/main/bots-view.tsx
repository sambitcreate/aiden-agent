import * as React from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { EmptyState, Text, toast } from "../components/ui";
import { botsApi } from "../lib/ipc";
import { userFacingErrorMessage } from "../lib/ipc-error";
import { queryKeys, useBot, useBots } from "../lib/queries";
import type { BotDefinition } from "../shared/bots";
import { BotAdvanced } from "./bots/bot-advanced";
import { BotCreateFlow } from "./bots/bot-create-flow";
import { BotDeleteDialog } from "./bots/bot-delete-dialog";
import { BotInstructionsEditor } from "./bots/bot-instructions-editor";
import { BotList, type BotListRow } from "./bots/bot-list";
import { BotNeedsModel } from "./bots/bot-needs-model";
import { BotProfile } from "./bots/bot-profile";
import type { BotSessionState } from "./bots/bot-session-state";
import { RemoteBots } from "./remote-bots";

type BotChatSummary = Awaited<ReturnType<typeof botsApi.openChat>>;

/**
 * Opens a Bot's one chat. A Bot without an AI model shows "Needs an AI model"
 * instead, and nothing is sent.
 */
function useOpenBotChat(onNeedsModel: (bot: BotDefinition) => void) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const opening = React.useRef(false);
  return async (bot: BotDefinition) => {
    if (opening.current) return;
    opening.current = true;
    try {
      const state = await botsApi.sessionState(bot.id);
      qc.setQueryData(queryKeys.botSessionState(bot.id), state);
      if (state.kind === "needs_model") {
        onNeedsModel(bot);
        return;
      }
      const chat = await botsApi.openChat(bot.id);
      qc.setQueryData(queryKeys.botChats(bot.id), chat);
      await navigate({
        to: "/bots/$botId/chat/$chatId",
        params: { botId: bot.id, chatId: chat.chatId },
      });
    } catch (error) {
      toast.error(userFacingErrorMessage(error, `Aiden couldn’t open ${bot.name}.`));
    } finally {
      opening.current = false;
    }
  };
}

function BotsHome() {
  const navigate = useNavigate();
  const bots = useBots();
  const active = React.useMemo(
    () => (bots.data ?? []).filter((bot) => bot.archivedAt === undefined),
    [bots.data],
  );
  const states = useQueries({
    queries: active.map((bot) => ({
      queryKey: queryKeys.botSessionState(bot.id),
      queryFn: () => botsApi.sessionState(bot.id),
      retry: false,
    })),
  });
  // TEMPORARY: the chat's title and time stand in for the live projection's
  // preview until the renderer moves to it (plan Task 1.4/2.3).
  const chats = useQueries({
    queries: active.map((bot, index) => ({
      queryKey: queryKeys.botChats(bot.id),
      queryFn: (): Promise<BotChatSummary> => botsApi.openChat(bot.id),
      enabled: states[index]?.data !== undefined && states[index]?.data?.kind !== "needs_model",
      retry: false,
    })),
  });
  const rows: BotListRow[] = active
    .map((bot, index): BotListRow => {
      const chat = chats[index]?.data;
      const state = states[index]?.data as BotSessionState | undefined;
      return {
        bot,
        ...(state ? { state } : {}),
        ...(chat ? { preview: chat.title, updatedAt: chat.updatedAt } : {}),
      };
    })
    .sort((left, right) => (right.updatedAt ?? right.bot.updatedAt) - (left.updatedAt ?? left.bot.updatedAt));
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<BotDefinition | null>(null);
  const [needsModel, setNeedsModel] = React.useState<BotDefinition | null>(null);
  const openChat = useOpenBotChat(setNeedsModel);

  if (needsModel) {
    return (
      <BotNeedsModel
        bot={needsModel}
        onBack={() => setNeedsModel(null)}
        onOpenProfile={() => void navigate({ to: "/bots/$botId", params: { botId: needsModel.id } })}
        onSetUp={() => void navigate({ to: "/settings", search: { section: "providers" } })}
      />
    );
  }
  return (
    <>
      <BotList
        rows={rows}
        loading={bots.isLoading}
        error={bots.isError}
        onRetry={() => void bots.refetch()}
        onOpen={(bot) => void openChat(bot)}
        onOpenProfile={(bot) => void navigate({ to: "/bots/$botId", params: { botId: bot.id } })}
        onDelete={setDeleting}
        onCreate={() => setCreating(true)}
      >
        <RemoteBots />
      </BotList>
      <BotCreateFlow
        open={creating}
        onOpenChange={setCreating}
        onCreated={(bot, { needsModel: missingModel }) =>
          missingModel ? setNeedsModel(bot) : openChat(bot)
        }
      />
      {deleting ? (
        <BotDeleteDialog
          bot={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}

type ProfilePage = "profile" | "instructions" | "advanced" | "needs-model";

function BotPage({ botId }: { botId: string }) {
  const navigate = useNavigate();
  const bot = useBot(botId);
  const [page, setPage] = React.useState<ProfilePage>("profile");
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => setPage("profile"), [botId]);
  const openChat = useOpenBotChat(() => setPage("needs-model"));

  if (bot.isLoading) return <Text color="secondary">Loading…</Text>;
  if (!bot.data || bot.data.archivedAt !== undefined) {
    return <EmptyState title="Bot not found" description="This Bot may have been deleted." />;
  }
  const current = bot.data;
  const back = () => setPage("profile");
  return (
    <>
      {page === "instructions" ? (
        <BotInstructionsEditor bot={current} onClose={back} />
      ) : page === "advanced" ? (
        <BotAdvanced bot={current} onClose={back} />
      ) : page === "needs-model" ? (
        <BotNeedsModel
          bot={current}
          onBack={back}
          onOpenProfile={back}
          onSetUp={() => void navigate({ to: "/settings", search: { section: "providers" } })}
        />
      ) : (
        <BotProfile
          bot={current}
          onBack={() => void navigate({ to: "/bots" })}
          onOpenChat={() => void openChat(current)}
          onOpenInstructions={() => setPage("instructions")}
          onOpenAdvanced={() => setPage("advanced")}
          onDelete={() => setDeleting(true)}
        />
      )}
      <BotDeleteDialog bot={current} open={deleting} onOpenChange={setDeleting} />
    </>
  );
}

/** Routes `/bots` to the Bots list and `/bots/$botId` to that Bot's Profile. */
export function BotsView() {
  const params = useParams({ strict: false }) as { botId?: string };
  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-8 pb-16 pt-16 max-[640px]:px-5">
        {params.botId ? <BotPage botId={params.botId} /> : <BotsHome />}
      </main>
    </div>
  );
}
