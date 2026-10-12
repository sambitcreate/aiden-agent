import * as React from "react";
import { Ellipsis, Plus, RotateCcw, Search, X } from "lucide-react";
import { BotAvatar } from "../../components/bot-avatar";
import {
  Button,
  Callout,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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

function BotRowMenuItems({
  bot,
  Item,
  Separator,
  onOpenProfile,
  onDelete,
}: {
  bot: BotDefinition;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  onOpenProfile(bot: BotDefinition): void;
  onDelete(bot: BotDefinition): void;
}) {
  return (
    <>
      <Item onSelect={() => onOpenProfile(bot)}>Profile</Item>
      <Separator />
      <Item color="status-red" onSelect={() => onDelete(bot)}>
        Delete Bot
      </Item>
    </>
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
    <li className="group relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-3 rounded-card py-2.5 pl-3 pr-12 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
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
          <BotRowMenuItems
            bot={bot}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
            onOpenProfile={onOpenProfile}
            onDelete={onDelete}
          />
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            iconOnly
            variant="transparent"
            size="medium"
            aria-label={`More for ${bot.name}`}
            className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <BotRowMenuItems
            bot={bot}
            Item={DropdownMenuItem}
            Separator={DropdownMenuSeparator}
            onOpenProfile={onOpenProfile}
            onDelete={onDelete}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Row-shaped placeholders while the Bots load. */
function BotListSkeleton() {
  return (
    <div role="status" aria-label="Loading Bots" className="space-y-0.5">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 px-3 py-2.5">
          <span className="size-10 shrink-0 rounded-full bg-control motion-safe:animate-pulse" />
          <span className="grid min-w-0 flex-1 gap-2">
            <span className="h-3 w-32 rounded-full bg-control motion-safe:animate-pulse" />
            <span className="h-2.5 w-56 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
          </span>
        </div>
      ))}
      <span className="sr-only">Loading Bots…</span>
    </div>
  );
}

/**
 * The identity-first Bots home: one row per Bot, and a tap opens its chat.
 * Profile and Delete Bot live in each row's ••• menu and context menu.
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
  emptyState,
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
  /** Replaces the default "No Bots yet" state, such as the starter carousel. */
  emptyState?: React.ReactNode;
  /** Extra sections rendered after the list, such as Bots on a paired Mac. */
  children?: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");
  const visible = rows.filter((row) => matchesSearch(row, query));
  const showSearch = !loading && !error && rows.length > 0;

  return (
    <div className="space-y-4">
      {showSearch ? (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search Bots"
            placeholder="Search Bots"
            className="pl-9 pr-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
          />
          {query ? (
            <Button
              iconOnly
              variant="transparent"
              size="small"
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setQuery("")}
            >
              <X />
            </Button>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <BotListSkeleton />
      ) : error ? (
        <Callout color="red" role="alert" className="flex-row items-center justify-between gap-4">
          <div>
            <Text variant="small-strong" color="red">
              Your Bots couldn’t be loaded
            </Text>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              Check that Aiden finished starting, then try again.
            </Text>
          </div>
          {onRetry ? (
            <Button size="small" variant="filled" onClick={onRetry}>
              <RotateCcw /> Try again
            </Button>
          ) : null}
        </Callout>
      ) : rows.length === 0 && emptyState ? (
        emptyState
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
        <EmptyState
          role="status"
          placement="inline"
          title="No matching Bots"
          description={`Nothing matches “${query.trim()}”.`}
        />
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
