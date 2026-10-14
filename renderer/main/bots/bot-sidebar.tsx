// The Bots-only sidebar (spec §9): ‹ back to Aiden, Search and New Bot on top;
// the pinned Bot, large, when one is pinned; one row per Bot, newest activity
// first, whose face glances while it works, with "Needs you" and an unread dot;
// Bots on paired Macs; the profile and Connect apps in the footer.

import * as React from "react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, Plug, Plus, RotateCcw, Search, UserRound, X } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import { HistoryNavButtons } from "../../components/history-nav";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Sidebar,
  SidebarFooter,
  SidebarListItem,
  SplitView,
} from "../../components/ui";
import { botChatPath, botRouteBotId, lastNonBotRoute } from "../../lib/bot-routes";
import { isBotUnread } from "../../lib/bot-sidebar-preferences";
import { useProfile } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import type { BotDefinition } from "../../shared/bots";
import { RemoteBots } from "../remote-bots";
import { BotCreateFlow } from "./bot-create-flow";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotRowMenus, useBotMenuActions, type BotMenuAction } from "./bot-menu";
import { botRowLine, matchesBotSearch, useBotRows, type BotSidebarRow } from "./bot-sidebar-rows";
import { useBotSidebarPreferences } from "./use-bot-sidebar-preferences";

const ROW_FOCUS =
  "outline-none focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring";

interface RowProps {
  row: BotSidebarRow;
  selected: boolean;
  unread: boolean;
  pinned: boolean;
  onOpen(bot: BotDefinition): void;
  onAction(bot: BotDefinition, action: BotMenuAction, returnFocus?: HTMLElement | null): void;
}

/** "Needs you" outranks the unread dot; a row that is both still says "Unread" to a screen reader. */
function RowMarkers({ row, unread }: { row: BotSidebarRow; unread: boolean }) {
  if (row.needsYou) {
    return (
      <>
        <Badge color="warning" className="h-5 shrink-0 px-1.5 text-mini">
          Needs you
        </Badge>
        {unread ? <span className="sr-only">Unread</span> : null}
      </>
    );
  }
  if (!unread) return null;
  return (
    <span role="img" aria-label="Unread" title="New reply" className="inline-flex size-5 shrink-0 items-center justify-center">
      <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
    </span>
  );
}

function BotRow({ row, selected, unread, pinned, onOpen, onAction }: RowProps) {
  const line = botRowLine(row);
  const rowRef = React.useRef<HTMLButtonElement>(null);
  return (
    <li className="group relative">
      <BotRowMenus
        bot={row.bot}
        pinned={pinned}
        rowRef={rowRef}
        moreClassName="right-1.5 top-1/2 -translate-y-1/2"
        onAction={(action, returnFocus) => onAction(row.bot, action, returnFocus)}
      >
        <button
          ref={rowRef}
          type="button"
          aria-current={selected ? "page" : undefined}
          className={cn(
            "flex w-full min-w-0 items-center gap-2.5 rounded-control py-1.5 pl-2 pr-9 text-left transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover motion-reduce:transition-none",
            ROW_FOCUS,
            selected && "bg-list-selection hover:bg-list-selection",
          )}
          onClick={() => onOpen(row.bot)}
        >
          <BotAvatar
            botId={row.bot.id}
            avatar={row.bot.avatar}
            name={row.bot.name}
            photoLoading="visible"
            size="medium"
            working={row.state?.kind === "running"}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-regular font-medium text-primary">{row.bot.name}</span>
            {line ? (
              <span
                className={cn(
                  "mt-0.5 block truncate text-small text-secondary",
                  line.kind === "working" && "agent-thinking-shimmer",
                )}
              >
                {line.text}
              </span>
            ) : null}
          </span>
          <RowMarkers row={row} unread={unread} />
        </button>
      </BotRowMenus>
    </li>
  );
}

function PinnedBot({ row, selected, unread, onOpen, onAction }: Omit<RowProps, "pinned">) {
  const rowRef = React.useRef<HTMLButtonElement>(null);
  return (
    <section aria-label="Pinned Bot" className="group relative mb-2">
      <BotRowMenus
        bot={row.bot}
        pinned
        rowRef={rowRef}
        moreClassName="right-1.5 top-1.5"
        onAction={(action, returnFocus) => onAction(row.bot, action, returnFocus)}
      >
        <button
          ref={rowRef}
          type="button"
          aria-current={selected ? "page" : undefined}
          className={cn(
            "flex w-full min-w-0 flex-col items-center gap-2 rounded-card px-3 py-3 transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover motion-reduce:transition-none",
            ROW_FOCUS,
            selected && "bg-list-selection hover:bg-list-selection",
          )}
          onClick={() => onOpen(row.bot)}
        >
          <BotAvatar
            botId={row.bot.id}
            avatar={row.bot.avatar}
            name={row.bot.name}
            photoLoading="visible"
            size="large"
            working={row.state?.kind === "running"}
          />
          <span className="flex max-w-full min-w-0 items-center gap-1.5">
            <span className="truncate text-strong font-medium text-primary">{row.bot.name}</span>
            <RowMarkers row={row} unread={unread} />
          </span>
        </button>
      </BotRowMenus>
    </section>
  );
}

function RowsSkeleton() {
  return (
    <div role="status" aria-label="Loading Bots" className="flex flex-col gap-0.5">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="size-9 shrink-0 rounded-card bg-control motion-safe:animate-pulse" />
          <span className="grid min-w-0 flex-1 gap-1.5">
            <span className="h-3 w-24 rounded-full bg-control motion-safe:animate-pulse" />
            <span className="h-2.5 w-36 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
          </span>
        </div>
      ))}
      <span className="sr-only">Loading Bots…</span>
    </div>
  );
}

function ProfileFace({ name }: { name: string }) {
  const initial = [...name.trim()][0]?.toLocaleUpperCase();
  return (
    <span
      aria-hidden="true"
      className="grid size-6 place-items-center rounded-full bg-control text-small-strong font-medium text-secondary"
    >
      {initial ?? <UserRound className="size-3.5" />}
    </span>
  );
}

export function BotSidebar() {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const currentBotId = botRouteBotId(pathname);
  const profile = useProfile();
  const { bots, rows } = useBotRows();
  const { preferences, prune } = useBotSidebarPreferences();
  const [query, setQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const searchButtonRef = React.useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<BotDefinition | null>(null);
  const act = useBotMenuActions(setDeleting);

  // Prune only on a settled, successful read: a loading, failed or refreshing
  // list may not show a Bot that exists, and pruning then would drop its pin.
  const listSettled = bots.isSuccess && !bots.isFetching;
  React.useEffect(() => {
    if (listSettled && bots.data) prune(new Set(bots.data.map((bot) => bot.id)));
  }, [bots.data, listSettled, prune]);

  React.useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const searching = query.trim().length > 0;
  const pinnedBotId = preferences.pinnedBotId;
  const pinnedRow = searching ? undefined : rows.find((row) => row.bot.id === pinnedBotId);
  const visible = rows.filter((row) => row !== pinnedRow && matchesBotSearch(row, query));
  const openChat = (bot: BotDefinition) => void navigate(botChatPath(bot.id));
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    searchButtonRef.current?.focus();
  };
  const rowProps = (row: BotSidebarRow) => ({
    row,
    selected: row.bot.id === currentBotId,
    unread: row.bot.id !== currentBotId && isBotUnread(preferences, row.bot.id, row.lastReplyAt),
    onOpen: openChat,
    onAction: act,
  });

  let list: React.ReactNode;
  if (bots.isPending) {
    list = <RowsSkeleton />;
  } else if (bots.isError) {
    list = (
      <div role="alert" className="flex flex-col gap-1">
        <EmptyState
          placement="inline"
          title="Your Bots couldn’t be loaded"
          description="Check that Aiden finished starting, then try again."
        />
        <SidebarListItem icon={<RotateCcw />} title="Try again" onClick={() => void bots.refetch()} />
      </div>
    );
  } else if (rows.length === 0) {
    list = (
      <EmptyState
        placement="inline"
        title="No Bots yet"
        description="A Bot is a helper with its own name, look, and instructions."
      />
    );
  } else if (searching && visible.length === 0) {
    list = (
      <EmptyState
        role="status"
        placement="inline"
        title="No matching Bots"
        description={`Nothing matches “${query.trim()}”.`}
      />
    );
  } else {
    list = (
      <>
        {pinnedRow ? <PinnedBot {...rowProps(pinnedRow)} /> : null}
        {visible.length > 0 ? (
          <ul aria-label="Your Bots" className="flex flex-col gap-0.5">
            {visible.map((row) => (
              <BotRow key={row.bot.id} {...rowProps(row)} pinned={row.bot.id === pinnedBotId} />
            ))}
          </ul>
        ) : null}
      </>
    );
  }

  return (
    <>
      <Sidebar
        actions={
          <SplitView.SidebarToggle>
            <HistoryNavButtons />
          </SplitView.SidebarToggle>
        }
        footer={
          <SidebarFooter>
            <div className="flex min-w-0 items-center gap-0.5">
              <SidebarListItem
                icon={<ProfileFace name={profile.data?.name ?? ""} />}
                title={profile.data?.name?.trim() || "Profile"}
                aria-label="Profile"
                selected={pathname === "/profile"}
                className="min-w-0 flex-1"
                onClick={() => void navigate({ to: "/profile" })}
              />
              <Button
                variant="transparent"
                size="small"
                className="shrink-0"
                onClick={() => void navigate({ to: "/settings", search: { section: "mcp" } })}
              >
                <Plug /> Connect apps
              </Button>
            </div>
          </SidebarFooter>
        }
      >
        {/* Below the title bar, which keeps the window controls and the sidebar toggle. */}
        <div className="flex items-center gap-1 px-2.5 pb-2">
          <Button
            iconOnly
            variant="bar"
            size="small"
            aria-label="Back to Aiden"
            title="Back to Aiden"
            onClick={() => void router.navigate({ href: lastNonBotRoute() })}
          >
            <ChevronLeft />
          </Button>
          <span className="flex-1" />
          <Button
            ref={searchButtonRef}
            iconOnly
            variant="bar"
            size="small"
            aria-label="Search Bots"
            title="Search Bots"
            aria-pressed={searchOpen}
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            <Search />
          </Button>
          <Button iconOnly variant="bar" size="small" aria-label="New Bot" title="New Bot" onClick={() => setCreating(true)}>
            <Plus />
          </Button>
        </div>
        {searchOpen ? (
          <div className="relative mx-2.5 mb-2">
            <Input
              ref={searchRef}
              type="search"
              aria-label="Search Bots"
              placeholder="Search Bots"
              className="pr-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                if (query) setQuery("");
                else closeSearch();
              }}
            />
            {query ? (
              <Button
                iconOnly
                variant="transparent"
                size="small"
                aria-label="Clear search"
                className="absolute right-1 top-1/2 -translate-y-1/2"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
              >
                <X />
              </Button>
            ) : null}
          </div>
        ) : null}
        <nav aria-label="Bots" className="flex flex-col px-2.5 pb-3">
          {list}
          <RemoteBots query={query} />
        </nav>
      </Sidebar>
      <BotCreateFlow open={creating} onOpenChange={setCreating} onCreated={(bot) => openChat(bot)} />
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
