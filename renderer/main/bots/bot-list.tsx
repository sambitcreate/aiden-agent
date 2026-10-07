import * as React from "react";
import { Plus, RotateCcw, Search, X } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  EmptyState,
  Input,
  Text,
} from "../../components/ui";
import type { BotDefinition } from "../../shared/bots";
import { botRowStatusLabel, type BotSessionState } from "./bot-session-state";

export interface BotListRow {
  bot: BotDefinition;
  /** Last message preview, already reduced to one line of plain text. */
  preview?: string;
  /** When the Bot's chat last changed. */
  updatedAt?: number;
  state?: BotSessionState;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Today shows a clock time, the last week a day name, anything older a date. */
export function formatBotRowTime(timestamp: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / 86_400_000);
  if (days <= 0) return timeFormatter.format(timestamp);
  if (days === 1) return "Yesterday";
  if (days < 7) return weekdayFormatter.format(timestamp);
  return dateFormatter.format(timestamp);
}

function matchesSearch(row: BotListRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [row.bot.name, row.bot.description ?? "", row.preview ?? ""].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function BotListItem({
  row,
  now,
  onOpen,
  onOpenProfile,
  onDelete,
}: {
  row: BotListRow;
  now: number;
  onOpen(bot: BotDefinition): void;
  onOpenProfile(bot: BotDefinition): void;
  onDelete(bot: BotDefinition): void;
}) {
  const { bot } = row;
  const status = botRowStatusLabel(row.state);
  const working = row.state?.kind === "running";
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-3 rounded-card px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => onOpen(bot)}
          >
            <span className="relative shrink-0">
              <BotAvatar
                botId={bot.id}
                avatar={bot.avatar}
                name={bot.name}
                photoLoading="visible"
                size="large"
              />
              {working ? (
                <span
                  className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-status-green ring-2 ring-background"
                  aria-hidden="true"
                />
              ) : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <Text as="span" variant="strong" className="min-w-0 truncate">
                  {bot.name}
                </Text>
                {bot.description ? (
                  <span className="min-w-0 max-w-[45%] shrink truncate rounded-pill bg-control px-2 py-0.5 text-small text-secondary">
                    {bot.description}
                  </span>
                ) : null}
                <span className="flex-1" />
                {row.updatedAt !== undefined ? (
                  <time
                    dateTime={new Date(row.updatedAt).toISOString()}
                    className="shrink-0 text-small tabular-nums text-tertiary"
                  >
                    {formatBotRowTime(row.updatedAt, now)}
                  </time>
                ) : null}
              </span>
              {status ? (
                <Text as="span" variant="small" color="secondary" className="mt-0.5 block truncate">
                  {status}
                </Text>
              ) : row.preview ? (
                <Text as="span" variant="small" color="secondary" className="mt-0.5 block truncate">
                  {row.preview}
                </Text>
              ) : null}
              {working ? <span className="sr-only">Working</span> : null}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onOpenProfile(bot)}>Profile</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem color="status-red" onSelect={() => onDelete(bot)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/**
 * The identity-first Bots home: one row per Bot, and a tap opens its chat.
 * Profile and Delete live in each row's context menu.
 */
export function BotList({
  rows,
  loading = false,
  error = false,
  onRetry,
  onOpen,
  onOpenProfile,
  onDelete,
  onCreate,
  now = Date.now(),
  children,
}: {
  rows: readonly BotListRow[];
  loading?: boolean;
  error?: boolean;
  onRetry?(): void;
  onOpen(bot: BotDefinition): void;
  onOpenProfile(bot: BotDefinition): void;
  onDelete(bot: BotDefinition): void;
  onCreate(): void;
  now?: number;
  /** Extra sections rendered after the list, such as Bots on a paired Mac. */
  children?: React.ReactNode;
}) {
  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const visible = rows.filter((row) => matchesSearch(row, query));
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <Text as="h1" variant="heading1">
          Bots
        </Text>
        <div className="flex items-center gap-2">
          <Button
            iconOnly
            variant="filled"
            size="large"
            aria-label={searching ? "Close search" : "Search Bots"}
            aria-pressed={searching}
            onClick={() => (searching ? closeSearch() : setSearching(true))}
          >
            {searching ? <X /> : <Search />}
          </Button>
          <Button iconOnly variant="filled" size="large" aria-label="New Bot" onClick={onCreate}>
            <Plus />
          </Button>
        </div>
      </header>
      {searching ? (
        <Input
          autoFocus
          type="search"
          aria-label="Search Bots"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeSearch();
          }}
        />
      ) : null}
      {loading ? (
        <Text as="p" color="secondary" role="status">
          Loading Bots…
        </Text>
      ) : error ? (
        <EmptyState
          role="alert"
          title="Your Bots couldn’t be loaded"
          action={
            onRetry ? (
              <Button size="small" variant="filled" onClick={onRetry}>
                <RotateCcw /> Try again
              </Button>
            ) : undefined
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No Bots yet"
          description="A Bot is a helper with its own name, look, and instructions."
          action={
            <Button variant="accent" onClick={onCreate}>
              <Plus /> New Bot
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <Text as="p" color="secondary" role="status">
          No Bots match “{query.trim()}”.
        </Text>
      ) : (
        <ul className="-mx-3 space-y-0.5" aria-label="Your Bots">
          {visible.map((row) => (
            <BotListItem
              key={row.bot.id}
              row={row}
              now={now}
              onOpen={onOpen}
              onOpenProfile={onOpenProfile}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}
