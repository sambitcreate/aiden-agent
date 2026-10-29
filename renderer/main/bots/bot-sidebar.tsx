// The Bots-only sidebar (spec §9): ‹ back to Aiden, Search and New Bot on top;
// the pinned Bot, large, when one is pinned; one row per Bot, newest activity
// first, whose face glances while it works, with "Needs you" and an unread dot;
// Bots on paired Macs; the profile and Connect apps in the footer.

import * as React from "react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, Plug, Plus, RotateCcw, Search, Star, UserRound, X } from "lucide-react";
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
  Text,
} from "../../components/ui";
import { botChatPath, botRouteBotId, hostBotChatRouteKey, lastNonBotRoute } from "../../lib/bot-routes";
import { isBotUnread } from "../../lib/bot-sidebar-preferences";
import { useProfile } from "../../lib/queries";
import { cn } from "../../lib/ui-utils";
import type { BotDefinition } from "../../shared/bots";
import { RemoteBotsSection, remoteBotGroupsMatching } from "../../components/remote-bots-section";
import { useRemoteBots } from "../remote-bots";
import { BotCreateFlow } from "./bot-create-flow";
import { BotDeleteDialog } from "./bot-delete-dialog";
import { BotRowMenus, useBotMenuActions, type BotMenuAction } from "./bot-menu";
import { botRowLine, matchesBotSearch, useBotRows, type BotSidebarRow } from "./bot-sidebar-rows";
import { useBotSidebarPreferences } from "./use-bot-sidebar-preferences";
import { pauseWhenUnseen } from "../../lib/offscreen-pause";

const ROW_FOCUS =
  "outline-none focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring";

/** A row's second line is its description, cut to a sentence's length: never a whole message. */
const ROW_LINE_LIMIT = 80;

function boundedLine(text: string): string {
  return text.length > ROW_LINE_LIMIT ? `${text.slice(0, ROW_LINE_LIMIT - 1).trimEnd()}…` : text;
}

interface RowProps {
  row: BotSidebarRow;
  selected: boolean;
  unread: boolean;
  pinned: boolean;
  onOpen(bot: BotDefinition): void;
  onAction(bot: BotDefinition, action: BotMenuAction, returnFocus?: HTMLElement | null): void;
}

/** A row re-renders only when what it shows changes, not on every sidebar render. */
function sameRowProps(previous: RowProps, next: RowProps): boolean {
  const a = previous.row;
  const b = next.row;
  return (
    a.bot === b.bot &&
    a.state === b.state &&
    a.preview === b.preview &&
    a.needsYou === b.needsYou &&
    previous.selected === next.selected &&
    previous.unread === next.unread &&
    previous.pinned === next.pinned &&
    previous.onOpen === next.onOpen &&
    previous.onAction === next.onAction
  );
}

/** The unread dot, inline after the name: it takes room only when it is there. */
function UnreadDot() {
  return (
    <span role="img" aria-label="Unread" title="New reply" className="inline-flex size-2 shrink-0 rounded-full bg-accent" />
  );
}

const NeedsYouBadge = () => (
  <Badge color="warning" className="h-5 shrink-0 px-1.5 text-mini">
    Needs you
  </Badge>
);

const BotRow = React.memo(function BotRow({ row, selected, unread, pinned, onOpen, onAction }: RowProps) {
  const line = botRowLine(row);
  const lineId = React.useId();
  const rowRef = React.useRef<HTMLButtonElement>(null);
  return (
    <li className="group relative">
      <BotRowMenus
        bot={row.bot}
        pinned={pinned}
        paused={row.state?.kind === "paused"}
        rowRef={rowRef}
        moreClassName="right-1.5 top-1/2 -translate-y-1/2"
        onAction={(action, returnFocus) => onAction(row.bot, action, returnFocus)}
      >
        <button
          ref={rowRef}
          type="button"
          data-bot-row={row.bot.id}
          aria-current={selected ? "page" : undefined}
          aria-describedby={line ? lineId : undefined}
          className={cn(
            "flex w-full min-w-0 items-center gap-2.5 rounded-control py-1.5 pl-2 pr-9 text-left transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover motion-reduce:transition-none",
            ROW_FOCUS,
            selected && "bg-list-selection hover:bg-list-selection",
          )}
          onClick={() => onOpen(row.bot)}
        >
          <span aria-hidden="true" className="shrink-0">
            <BotAvatar
              botId={row.bot.id}
              avatar={row.bot.avatar}
              name={row.bot.name}
              photoLoading="visible"
              size="medium"
              working={row.state?.kind === "running"}
            />
          </span>
          {/* Every row's text spans the same width, so names and previews line up. */}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-regular font-medium text-primary">{row.bot.name}</span>
              {/* "Needs you" outranks the dot; the row still says "Unread" to a screen reader. */}
              {unread && !row.needsYou ? <UnreadDot /> : null}
            </span>
            {line || row.needsYou ? (
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                {row.needsYou ? <NeedsYouBadge /> : null}
                {row.needsYou && unread ? <span className="sr-only">Unread</span> : null}
                {line ? (
                  // Read as the row's description, so its name stays the Bot's name and status.
                  <span
                    id={lineId}
                    aria-hidden="true"
                    ref={line.kind === "working" ? pauseWhenUnseen : undefined}
                    className={cn(
                      "block min-w-0 truncate text-small text-secondary",
                      line.kind === "working" && "agent-thinking-shimmer",
                    )}
                  >
                    {boundedLine(line.text)}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
      </BotRowMenus>
    </li>
  );
}, sameRowProps);

const PinnedBot = React.memo(function PinnedBot({ row, selected, unread, onOpen, onAction }: RowProps) {
  const rowRef = React.useRef<HTMLButtonElement>(null);
  const lineId = React.useId();
  // The hero shows no preview; like the rows, it says when the Bot is working
  // or why it stopped, as its description. "Needs you" is its own badge.
  const line = botRowLine(row);
  const description = line && (line.kind === "working" || line.kind === "status") ? line.text : null;
  return (
    <section aria-label="Pinned Bot" className="group relative mb-2">
      <BotRowMenus
        bot={row.bot}
        pinned
        paused={row.state?.kind === "paused"}
        rowRef={rowRef}
        moreClassName="right-1.5 top-1.5"
        onAction={(action, returnFocus) => onAction(row.bot, action, returnFocus)}
      >
        <button
          ref={rowRef}
          type="button"
          data-bot-row={row.bot.id}
          aria-current={selected ? "page" : undefined}
          aria-describedby={description ? lineId : undefined}
          className={cn(
            "flex w-full min-w-0 flex-col items-center gap-2 rounded-card px-3 py-3 transition-[background-color] duration-(--motion-duration) ease-standard hover:bg-list-hover motion-reduce:transition-none",
            ROW_FOCUS,
            selected && "bg-list-selection hover:bg-list-selection",
          )}
          onClick={() => onOpen(row.bot)}
        >
          <span aria-hidden="true" className="relative shrink-0">
            <BotAvatar
              botId={row.bot.id}
              avatar={row.bot.avatar}
              name={row.bot.name}
              photoLoading="visible"
              size="large"
              working={row.state?.kind === "running"}
            />
            {/* The pin mark; "Pinned Bot" names the region for screen readers. */}
            <span className="absolute -bottom-1 -right-1 grid size-4.5 place-items-center rounded-full bg-status-warning-surface text-status-warning">
              <Star className="size-2.5 fill-current" />
            </span>
          </span>
          <span className="flex max-w-full min-w-0 items-center gap-1.5">
            <span className="truncate text-strong font-medium text-primary">{row.bot.name}</span>
            {row.needsYou ? <NeedsYouBadge /> : unread ? <UnreadDot /> : null}
            {row.needsYou && unread ? <span className="sr-only">Unread</span> : null}
          </span>
          {description ? (
            <span id={lineId} hidden>
              {description}
            </span>
          ) : null}
        </button>
      </BotRowMenus>
    </section>
  );
}, sameRowProps);

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
  const profileName = profile.data?.name?.trim() ?? "";
  const { bots, rows } = useBotRows();
  const remote = useRemoteBots();
  const { preferences, prune } = useBotSidebarPreferences();
  const [query, setQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const searchButtonRef = React.useRef<HTMLButtonElement>(null);
  const newBotRef = React.useRef<HTMLButtonElement>(null);
  const navRef = React.useRef<HTMLElement>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<{ bot: BotDefinition; neighbours: string[] } | null>(null);
  // The rows in the order they are on screen: the pinned Bot first, then the list.
  const visibleIdsRef = React.useRef<string[]>([]);
  // Deleting a row's Bot leaves focus on the nearest row on screen (below, then above), else New Bot.
  const startDelete = React.useCallback((bot: BotDefinition) => {
    const ids = visibleIdsRef.current;
    const at = ids.indexOf(bot.id);
    const neighbours = at < 0 ? [] : [...ids.slice(at + 1), ...ids.slice(0, at).reverse()];
    setDeleting({ bot, neighbours });
  }, []);
  const act = useBotMenuActions(startDelete);

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
  visibleIdsRef.current = [...(pinnedRow ? [pinnedRow.bot.id] : []), ...visible.map((row) => row.bot.id)];
  const remoteShown = remoteBotGroupsMatching(remote.groups, query);
  const openChat = React.useCallback((bot: BotDefinition) => void navigate(botChatPath(bot.id)), [navigate]);
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    searchButtonRef.current?.focus();
  };
  const rowFor = (botId: string) =>
    Array.from(navRef.current?.querySelectorAll<HTMLElement>("[data-bot-row]") ?? []).find(
      (element) => element.dataset.botRow === botId,
    ) ?? null;
  const deleteReturnFocus = () => {
    if (!deleting) return null;
    // Cancelled: the row is still there. Deleted: the nearest remaining row, else New Bot.
    for (const botId of [deleting.bot.id, ...deleting.neighbours]) {
      const element = rowFor(botId);
      if (element) return element;
    }
    return newBotRef.current;
  };
  const rowProps = (row: BotSidebarRow) => ({
    row,
    selected: row.bot.id === currentBotId,
    unread: row.bot.id !== currentBotId && isBotUnread(preferences, row.bot.id, row.lastReplyAt),
    pinned: row.bot.id === pinnedBotId,
    onOpen: openChat,
    onAction: act,
  });

  const retry = <SidebarListItem icon={<RotateCcw />} title="Try again" onClick={() => void bots.refetch()} />;
  let list: React.ReactNode;
  if (bots.isPending) {
    list = <RowsSkeleton />;
  } else if (bots.isError && !bots.data) {
    list = (
      <div role="alert" className="flex flex-col gap-1">
        <EmptyState
          placement="inline"
          title="Your Bots couldn’t be loaded"
          description="Check that Aiden finished starting, then try again."
        />
        {retry}
      </div>
    );
  } else if (rows.length === 0) {
    // Bots on a paired Mac below are Bots too; the empty state is only for no Bots anywhere.
    list =
      remote.groups.length > 0 ? null : (
        <EmptyState
          placement="inline"
          title="No Bots yet"
          description="A Bot is a helper with its own name, look, and instructions."
        />
      );
  } else if (searching && visible.length === 0) {
    list =
      remoteShown.length > 0 ? null : (
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
              <BotRow key={row.bot.id} {...rowProps(row)} />
            ))}
          </ul>
        ) : null}
      </>
    );
  }
  // A failed refresh keeps the Bots already shown, with a way to try again.
  const refreshFailed =
    bots.isError && bots.data ? (
      <div role="alert" className="mb-2 flex flex-col gap-0.5">
        <Text as="p" variant="small" color="secondary" className="px-2.5">
          Your Bots couldn’t be updated.
        </Text>
        {retry}
      </div>
    ) : null;

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
                icon={<ProfileFace name={profileName} />}
                title={profileName || "Profile"}
                // Starts with the visible name, so speech and voice control agree.
                aria-label={profileName ? `${profileName}, Profile` : undefined}
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
          <Button
            ref={newBotRef}
            iconOnly
            variant="bar"
            size="small"
            aria-label="New Bot"
            title="New Bot"
            onClick={() => setCreating(true)}
          >
            <Plus />
          </Button>
        </div>
        {searchOpen ? (
          <div className="relative mx-2.5 mb-2">
            <Input
              ref={searchRef}
              // A text field in the search role: type="search" adds WebKit's own clear
              // button beside the "Clear search" one below.
              type="text"
              role="searchbox"
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
        <nav ref={navRef} aria-label="Bots" className="flex flex-col px-2.5 pb-3">
          {refreshFailed}
          {list}
          <RemoteBotsSection
            groups={remoteShown}
            opening={remote.opening}
            selected={hostBotChatRouteKey(pathname)}
            onOpen={remote.open}
          />
        </nav>
      </Sidebar>
      <BotCreateFlow open={creating} onOpenChange={setCreating} onCreated={(bot) => openChat(bot)} />
      {deleting ? (
        <BotDeleteDialog
          bot={deleting.bot}
          open
          returnFocus={deleteReturnFocus}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}
