// The lead chat's chip for the chats it started ("3 chats working"). It opens
// a list with each chat's state, Open and Stop, and Stop all at the bottom.
// Stopping here is the person's own Stop: it ends the started chat's turn and
// the lead is not woken for it.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger, Text, toast } from "./ui";
import { chatsApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { cn } from "../lib/ui-utils";
import {
  startedChatStatus,
  startedChatsChipLabel,
  startedChatWorking,
  type StartedChatView,
} from "../shared/child-chats";

function needsPerson(view: StartedChatView): boolean {
  return (
    !view.tookOver && (view.state === "waiting_for_approval" || view.state === "waiting_for_input")
  );
}

function dotClass(view: StartedChatView): string {
  if (needsPerson(view)) return "bg-status-warning";
  if (view.tookOver) return "bg-quaternary";
  if (view.state === "running") return "bg-accent";
  if (view.state === "done")
    return view.outcome === "stopped" ? "bg-quaternary" : "bg-status-green";
  if (view.state === "failed") return "bg-status-red";
  return "bg-quaternary";
}

/** The chip and its list; renders nothing while the chat started none. */
export function StartedChatsChipView({
  leadChatId,
  views,
  onOpen,
  onChanged,
}: {
  leadChatId: string;
  views: readonly StartedChatView[];
  onOpen: (chatId: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [stopping, setStopping] = React.useState<ReadonlySet<string>>(() => new Set());
  if (!views.length) return null;
  const label = startedChatsChipLabel(views);
  const waiting = views.filter(needsPerson).length;
  const working = views.filter(
    (view) => startedChatWorking(view) && !view.tookOver && !stopping.has(view.chatId),
  );
  const fail = (error: unknown, fallback: string) =>
    toast.error(error instanceof Error ? error.message : fallback);
  const settle = (ids: readonly string[]) =>
    setStopping((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  // Show the row as stopping at once; main's change notice settles it.
  const stop = (view: StartedChatView) => {
    setStopping((current) => new Set(current).add(view.chatId));
    void chatsApi
      .stopStartedChat(leadChatId, view.chatId)
      .then(onChanged)
      .catch((error: unknown) => fail(error, "That chat could not be stopped."))
      .finally(() => settle([view.chatId]));
  };
  const stopAll = () => {
    const ids = working.map((view) => view.chatId);
    setStopping((current) => new Set([...current, ...ids]));
    void chatsApi
      .stopAllStartedChats(leadChatId)
      .then(onChanged)
      .catch((error: unknown) => fail(error, "The started chats could not be stopped."))
      .finally(() => settle(ids));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="transparent"
          size="small"
          className="h-7 shrink-0 gap-1.5 px-2 text-secondary"
          aria-label={
            waiting > 0 ? `${label}, ${waiting} ${waiting === 1 ? "needs" : "need"} you` : label
          }
          data-started-chats-chip=""
        >
          <MessagesSquare
            aria-hidden="true"
            className={cn("size-4 shrink-0", waiting > 0 && "text-status-warning")}
          />
          <span className="max-w-[12rem] truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] p-0" aria-label="Started chats">
        <div className="px-3 pb-1 pt-2.5">
          <Text as="h3" variant="small-strong" color="secondary">
            Started chats
          </Text>
        </div>
        <ul className="flex max-h-80 flex-col overflow-y-auto px-1.5 pb-2">
          {views.map((view) => {
            const isStopping = stopping.has(view.chatId);
            const canStop = startedChatWorking(view) && !view.tookOver && !isStopping;
            return (
              <li
                key={view.chatId}
                className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5"
                data-started-chat-row={view.chatId}
              >
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 shrink-0 rounded-full", dotClass(view))}
                />
                <div className="min-w-0 flex-1">
                  <Text as="p" variant="small-strong" className="truncate">
                    {view.title}
                  </Text>
                  <Text as="p" variant="small" color="tertiary" className="truncate">
                    {isStopping ? "Stopping…" : startedChatStatus(view)}
                  </Text>
                </div>
                <Button
                  variant="transparent"
                  size="small"
                  className="shrink-0 px-2"
                  aria-label={`Open “${view.title}”`}
                  onClick={() => {
                    setOpen(false);
                    onOpen(view.chatId);
                  }}
                >
                  Open
                </Button>
                {canStop ? (
                  <Button
                    variant="transparent"
                    size="small"
                    className="shrink-0 px-2"
                    aria-label={`Stop “${view.title}”`}
                    onClick={() => stop(view)}
                  >
                    Stop
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between gap-2 border-t border-separator px-3 py-1.5">
          <p className="min-w-0 text-small text-tertiary">
            This chat hears back when each one finishes.
          </p>
          {working.length > 0 ? (
            <Button variant="transparent" size="small" className="shrink-0 px-2" onClick={stopAll}>
              Stop all
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function StartedChatsChip({
  leadChatId,
  views,
}: {
  leadChatId: string;
  views: readonly StartedChatView[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const onChanged = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.startedChats(leadChatId) });
  }, [queryClient, leadChatId]);
  const onOpen = React.useCallback(
    (chatId: string) => void navigate({ to: "/chat/$chatId", params: { chatId } }),
    [navigate],
  );
  return (
    <StartedChatsChipView
      leadChatId={leadChatId}
      views={views}
      onOpen={onOpen}
      onChanged={onChanged}
    />
  );
}
