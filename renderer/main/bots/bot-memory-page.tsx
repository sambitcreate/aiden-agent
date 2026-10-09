// Profile → Memory: what a Bot remembers about the person (USER.md) and its own
// notes (MEMORY.md). The person can read, correct, delete and erase it; adding
// entries by hand is out of scope. The page live-updates on `bots:memory:changed`.

import * as React from "react";
import { Ellipsis, RotateCcw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Button,
  Callout,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Text,
  Textarea,
  toast,
} from "../../components/ui";
import { botsApi } from "../../lib/ipc";
import { userFacingErrorMessage } from "../../lib/ipc-error";
import {
  BOT_MEMORY_LIMITS,
  type BotMemoryEdit,
  type BotMemoryEditResult,
  type BotMemoryEntry,
  type BotMemoryStoreView,
  type BotMemoryTarget,
  type BotMemoryView,
} from "../../shared/bot-memory";
import type { BotDefinition } from "../../shared/bots";
import { BotPageShell, BotPageSkeleton } from "./bot-page-shell";
import { botMemoryCount, storeBotMemoryView, useBotMemory } from "./use-bot-memory";

const numberFormat = new Intl.NumberFormat();
/** How long a deleted memory can be brought back before the delete is sent. */
const UNDO_WINDOW_MS = 6_000;

export const BOT_MEMORY_BLOCKED_TEXT =
  "This can’t be saved because it looks like a password or an instruction to the Bot.";

/** The person-facing sentence for an edit main refused. */
export function botMemoryEditErrorText(
  result: Extract<BotMemoryEditResult, { ok: false }>,
  groupTitle: string,
): string {
  switch (result.code) {
    case "blocked":
      return BOT_MEMORY_BLOCKED_TEXT;
    case "over_budget":
      return `That would make “${groupTitle}” too long. Shorten it, or delete something else first.`;
    case "entry_not_found":
      return "This memory changed since you opened it. Close this and try again.";
    case "invalid":
      return result.message.trim() || "This can’t be saved.";
  }
}

function groupTitle(target: BotMemoryTarget, botName: string): string {
  return target === "user" ? "About you" : `${botName}’s notes`;
}

interface PendingRemoval {
  target: BotMemoryTarget;
  entry: BotMemoryEntry;
}

const removalKey = (target: BotMemoryTarget, entryId: string) => `${target}:${entryId}`;

/** A slim neutral meter: how much of the store's character budget is used. */
function UsageMeter({ title, store }: { title: string; store: BotMemoryStoreView }) {
  const percent = store.limitChars > 0 ? Math.min(100, Math.round((store.usedChars / store.limitChars) * 100)) : 0;
  const text = `${numberFormat.format(store.usedChars)} of ${numberFormat.format(store.limitChars)} characters`;
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div
        role="meter"
        aria-label={`${title} space used`}
        aria-valuemin={0}
        aria-valuemax={store.limitChars}
        aria-valuenow={Math.min(store.usedChars, store.limitChars)}
        aria-valuetext={text}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-control"
      >
        <div
          className="h-full rounded-full bg-tertiary transition-[width] duration-(--motion-duration) ease-standard motion-reduce:transition-none"
          style={{ width: `${percent}%` }}
        />
      </div>
      <Text variant="small" color="tertiary" className="shrink-0 tabular-nums" aria-hidden="true">
        {percent}% full
      </Text>
    </div>
  );
}

function MemoryGroup({
  target,
  botName,
  store,
  hidden,
  emptyText,
  onEdit,
  onDelete,
}: {
  target: BotMemoryTarget;
  botName: string;
  store: BotMemoryStoreView;
  hidden: ReadonlySet<string>;
  emptyText: string;
  onEdit(entry: BotMemoryEntry): void;
  onDelete(entry: BotMemoryEntry): void;
}) {
  const title = groupTitle(target, botName);
  const titleId = React.useId();
  const entries = store.entries.filter((entry) => !hidden.has(removalKey(target, entry.id)));
  const separator = "relative after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator";
  return (
    <section aria-labelledby={titleId} className="settings-group mb-7">
      <h2 id={titleId} className="settings-group-title mb-3 px-4 text-large-strong text-primary">
        {title}
      </h2>
      <div className="settings-group-card overflow-visible rounded-card bg-well">
        {entries.length === 0 ? (
          <Text as="p" variant="small" color="secondary" className={`${separator} px-4 py-3`}>
            {emptyText}
          </Text>
        ) : (
          <ul aria-label={title}>
            {entries.map((entry) => (
              <MemoryRow
                key={entry.id}
                entry={entry}
                className={separator}
                onEdit={() => onEdit(entry)}
                onDelete={() => onDelete(entry)}
              />
            ))}
          </ul>
        )}
        {store.overBudget ? (
          <Text as="p" variant="small" color="secondary" className={`${separator} px-4 py-3`}>
            This is over its limit. {botName} can’t save more here until something is removed.
          </Text>
        ) : null}
        <UsageMeter title={title} store={store} />
      </div>
    </section>
  );
}

function MemoryRow({
  entry,
  className,
  onEdit,
  onDelete,
}: {
  entry: BotMemoryEntry;
  className: string;
  onEdit(): void;
  onDelete(): void;
}) {
  const textId = React.useId();
  return (
    <li className={`${className} flex min-w-0 items-start gap-3 py-2.5 pl-4 pr-2`}>
      <p id={textId} className="min-w-0 flex-1 select-text whitespace-pre-wrap py-1 text-regular text-primary [overflow-wrap:anywhere]">
        {entry.text}
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button iconOnly variant="transparent" size="small" aria-label="Memory options" aria-describedby={textId}>
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
          <DropdownMenuItem color="status-red" onSelect={onDelete}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** Edit one entry: a textarea with a count, and main's refusal in a red callout. */
function EditMemoryDialog({
  botId,
  target,
  title,
  entry,
  onClose,
  onView,
}: {
  botId: string;
  target: BotMemoryTarget;
  title: string;
  entry: BotMemoryEntry;
  onClose(): void;
  onView(view: BotMemoryView): void;
}) {
  const [text, setText] = React.useState(entry.text);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const counterId = React.useId();
  const trimmed = text.trim();
  const save = async () => {
    if (busy || !trimmed || trimmed === entry.text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await botsApi.memory.edit({
        botId,
        edit: { kind: "replace", target, entryId: entry.id, text: trimmed },
      });
      onView(result.view);
      if (result.ok) onClose();
      else setError(botMemoryEditErrorText(result, title));
    } catch (caught) {
      setError(userFacingErrorMessage(caught, "Aiden couldn’t save this change."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit memory"
      description={title}
      confirmLabel={busy ? "Saving…" : "Save"}
      confirmDisabled={!trimmed || trimmed === entry.text}
      busy={busy}
      submitOnEnter
      onConfirm={save}
    >
      <div className="flex flex-col gap-2">
        <Textarea
          autoFocus
          aria-label="Memory"
          aria-describedby={counterId}
          className="min-h-28"
          value={text}
          maxLength={BOT_MEMORY_LIMITS.entryChars}
          disabled={busy}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />
        <Text id={counterId} as="p" variant="small" color="tertiary" className="self-end tabular-nums">
          {`${numberFormat.format(text.length)} / ${numberFormat.format(BOT_MEMORY_LIMITS.entryChars)}`}
        </Text>
        {error ? (
          <Callout color="red" role="alert">
            <Text as="p" variant="small" color="status-red">
              {error}
            </Text>
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Deletes wait out a short Undo window before they reach main: the row leaves
 * at once, Undo brings it back untouched, and the delete is sent when the
 * toast closes or the page does. Main has no person "add", so this is how Undo
 * restores an entry exactly (same text, same id).
 */
function useDeferredRemovals(botId: string, onView: (view: BotMemoryView) => void, botName: string) {
  const pending = React.useRef(new Map<string, PendingRemoval>());
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(() => new Set());
  const unhide = React.useCallback((key: string) => {
    setHidden((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  const commit = React.useCallback(
    async (key: string) => {
      const item = pending.current.get(key);
      if (!item) return;
      pending.current.delete(key);
      const edit: BotMemoryEdit = { kind: "remove", target: item.target, entryId: item.entry.id };
      try {
        const result = await botsApi.memory.edit({ botId, edit });
        onView(result.view);
        // Already gone (removed elsewhere) is what the person wanted.
        if (!result.ok && result.code !== "entry_not_found") {
          toast.error(botMemoryEditErrorText(result, groupTitle(item.target, botName)));
        }
      } catch (caught) {
        toast.error(userFacingErrorMessage(caught, "Aiden couldn’t delete that memory."));
      } finally {
        unhide(key);
      }
    },
    [botId, botName, onView, unhide],
  );
  const remove = (target: BotMemoryTarget, entry: BotMemoryEntry) => {
    const key = removalKey(target, entry.id);
    pending.current.set(key, { target, entry });
    setHidden((current) => new Set(current).add(key));
    toast("Deleted from memory", {
      id: `bot-memory-delete:${botId}:${key}`,
      duration: UNDO_WINDOW_MS,
      action: {
        label: "Undo",
        onClick: () => {
          pending.current.delete(key);
          unhide(key);
        },
      },
      onAutoClose: () => void commit(key),
      onDismiss: () => void commit(key),
    });
  };
  // Leaving the page sends every delete still waiting.
  const commitRef = React.useRef(commit);
  commitRef.current = commit;
  React.useEffect(() => {
    const map = pending.current;
    return () => {
      for (const key of [...map.keys()]) void commitRef.current(key);
    };
  }, []);
  /** Erase supersedes any delete still waiting. */
  const forgetAll = () => {
    pending.current.clear();
    setHidden(new Set());
  };
  return { hidden, remove, forgetAll };
}

export function BotMemoryPage({
  bot,
  onClose,
}: {
  bot: Pick<BotDefinition, "id" | "name">;
  onClose(): void;
}) {
  const qc = useQueryClient();
  const memory = useBotMemory(bot.id);
  const [editing, setEditing] = React.useState<{ target: BotMemoryTarget; entry: BotMemoryEntry } | null>(null);
  const [erasing, setErasing] = React.useState(false);
  const [erasingBusy, setErasingBusy] = React.useState(false);
  const onView = React.useCallback((view: BotMemoryView) => storeBotMemoryView(qc, view), [qc]);
  const removals = useDeferredRemovals(bot.id, onView, bot.name);
  const view = memory.data;

  const erase = async () => {
    setErasingBusy(true);
    removals.forgetAll();
    try {
      const result = await botsApi.memory.edit({ botId: bot.id, edit: { kind: "clear" } });
      onView(result.view);
      if (result.ok) {
        setErasing(false);
        toast.success("Memory erased");
      } else {
        toast.error(result.message.trim() || "Aiden couldn’t erase this memory.");
      }
    } catch (caught) {
      toast.error(userFacingErrorMessage(caught, "Aiden couldn’t erase this memory."));
    } finally {
      setErasingBusy(false);
    }
  };

  let body: React.ReactNode;
  if (memory.isLoading) {
    body = <BotPageSkeleton label="Loading memory" groups={[2, 2]} />;
  } else if (!view) {
    body = (
      <Callout color="red" role="alert" className="mb-7 flex-row items-center justify-between gap-4">
        <Text as="p" variant="small" color="status-red">
          Aiden couldn’t load {bot.name}’s memory.
        </Text>
        <Button size="small" variant="filled" onClick={() => void memory.refetch()}>
          <RotateCcw /> Try again
        </Button>
      </Callout>
    );
  } else if (!view.readable) {
    body = (
      <Callout color="red" role="alert" className="mb-7 gap-3">
        <div>
          <Text as="p" variant="small-strong" color="status-red">
            Memory couldn’t be read
          </Text>
          <Text as="p" variant="small" color="secondary" className="mt-0.5">
            Its files may be damaged. Erasing starts {bot.name}’s memory fresh.
          </Text>
        </div>
        <div>
          <Button size="small" variant="destructive" onClick={() => setErasing(true)}>
            Erase memory
          </Button>
        </div>
      </Callout>
    );
  } else {
    body = (
      <>
        <MemoryGroup
          target="user"
          botName={bot.name}
          store={view.user}
          hidden={removals.hidden}
          emptyText={`Nothing yet. Tell ${bot.name} something to remember, like “I’m vegetarian.”`}
          onEdit={(entry) => setEditing({ target: "user", entry })}
          onDelete={(entry) => removals.remove("user", entry)}
        />
        <MemoryGroup
          target="memory"
          botName={bot.name}
          store={view.memory}
          hidden={removals.hidden}
          emptyText={`Nothing yet. ${bot.name} keeps notes here as it helps you.`}
          onEdit={(entry) => setEditing({ target: "memory", entry })}
          onDelete={(entry) => removals.remove("memory", entry)}
        />
        {botMemoryCount(view) > 0 ? (
          <div className="flex justify-center">
            <Button variant="destructive" onClick={() => setErasing(true)}>
              Erase memory
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <BotPageShell
      scrollId={`bot-memory:${bot.id}`}
      title={bot.name}
      backLabel="Back"
      onBack={onClose}
      heading="Memory"
      description={`What ${bot.name} remembers about you and its work. It’s stored on this Mac, and ${bot.name} uses it in every chat.`}
    >
      {body}
      {editing ? (
        <EditMemoryDialog
          key={`${editing.target}:${editing.entry.id}`}
          botId={bot.id}
          target={editing.target}
          title={groupTitle(editing.target, bot.name)}
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onView={onView}
        />
      ) : null}
      <AlertDialog
        open={erasing}
        onOpenChange={(open) => {
          if (!erasingBusy) setErasing(open);
        }}
        title={`Erase everything ${bot.name} remembers?`}
        description="This can’t be undone."
        confirmLabel="Erase memory"
        confirmVariant="destructive"
        busy={erasingBusy}
        keepOpenOnConfirm
        onConfirm={erase}
      />
    </BotPageShell>
  );
}

