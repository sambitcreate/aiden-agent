import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  FileText,
  GripVertical,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { Button, Dialog, Textarea, toast } from "./ui";
import { type ChatMessageQueue, type QueuedChatMessage } from "../lib/chat-message-queue";

export function QueuedMessages({
  queue,
  canSteer,
  onSteer,
  returnFocus,
}: {
  queue: ChatMessageQueue;
  canSteer: boolean;
  onSteer: (id: string) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const state = React.useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [draft, setDraft] = React.useState<QueuedChatMessage | null>(null);
  const editorTrigger = React.useRef<HTMLButtonElement | null>(null);
  const draggedId = React.useRef<string | null>(null);
  React.useEffect(() => () => queue.closeEditor(), [queue]);
  if (state.messages.length === 0) return null;
  const editing = state.messages.find((message) => message.id === state.editingId);
  const draftIndex = state.messages.findIndex((message) => message.id === draft?.id);
  return (
    <section aria-label="Queued messages" className="mx-3 rounded-t-xl bg-context-bar px-2 py-1.5">
      <div className="flex items-center justify-between gap-2 px-1 text-small text-tertiary">
        <span role="status">
          {state.messages.length} queued{state.paused ? " · Paused" : ""}
        </span>
        <Button
          variant="transparent"
          size="small"
          disabled={Boolean(state.sendingId)}
          onClick={() => (state.paused ? queue.resume() : queue.pause())}
        >
          {state.paused ? "Resume queue" : "Pause queue"}
        </Button>
      </div>
      <ol className="max-h-44 overflow-y-auto">
        {state.messages.map((message, index) => (
          <li
            key={message.id}
            className="flex min-w-0 items-center gap-1 rounded-control py-0.5"
            onDragOver={(event) => {
              if (draggedId.current) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!draggedId.current) return;
              event.preventDefault();
              event.stopPropagation();
              queue.move(draggedId.current, index);
              draggedId.current = null;
            }}
          >
            <button
              type="button"
              draggable={!state.sendingId}
              disabled={Boolean(state.sendingId)}
              aria-label={`Reorder queued message ${index + 1}`}
              title="Drag to reorder, or use Alt+Arrow Up/Down"
              className="grid size-8 shrink-0 place-items-center rounded-control text-tertiary hover:bg-list-hover"
              onDragStart={(event) => {
                draggedId.current = message.id;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", message.id);
              }}
              onDragEnd={() => {
                draggedId.current = null;
              }}
              onKeyDown={(event) => {
                if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                  event.preventDefault();
                  queue.move(message.id, index + (event.key === "ArrowUp" ? -1 : 1));
                }
              }}
            >
              <GripVertical aria-hidden="true" className="size-3.5" />
            </button>
            {message.attachments[0] ? (
              message.attachments[0].kind === "image" ? (
                <img
                  src={`data:${message.attachments[0].mimeType};base64,${message.attachments[0].data}`}
                  alt={message.attachments[0].name}
                  className="size-8 shrink-0 rounded-md object-cover"
                />
              ) : (
                <FileText aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
              )
            ) : null}
            <span className="min-w-0 flex-1 truncate text-regular" title={message.text}>
              {message.text || message.attachments.map((attachment) => attachment.name).join(", ")}
            </span>
            <Button
              variant="transparent"
              size="small"
              disabled={!canSteer || Boolean(state.sendingId || editing)}
              onClick={() => onSteer(message.id)}
              aria-label={`Steer with queued message ${index + 1}`}
              title="Stop the current response, wait for it to save, then send this message next"
            >
              <CornerDownRight aria-hidden="true" />
              Steer
            </Button>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              disabled={state.sendingId === message.id}
              aria-label={`Delete queued message ${index + 1}`}
              onClick={() => {
                const target = returnFocus();
                queue.remove(message.id);
                requestAnimationFrame(() => {
                  if (target?.isConnected) target.focus({ preventScroll: true });
                });
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
            <Button
              variant="transparent"
              size="small"
              iconOnly
              disabled={Boolean(state.sendingId)}
              aria-label={`Edit queued message ${index + 1}`}
              aria-haspopup="dialog"
              onClick={(event) => {
                if (!queue.edit(message.id)) return;
                editorTrigger.current = event.currentTarget;
                setDraft(structuredClone(message));
              }}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ol>
      <p className="px-1 pt-1 text-small text-tertiary">
        Unsent messages stay in this window until it closes. Open this chat to continue its queue.
      </p>
      <Dialog
        open={Boolean(editing && draft)}
        title="Edit queued message"
        description="Save changes to the queued message. Your composer draft stays separate."
        confirmLabel="Save changes"
        confirmDisabled={!draft || (!draft.text.trim() && draft.attachments.length === 0)}
        returnFocus={() =>
          editorTrigger.current?.isConnected ? editorTrigger.current : returnFocus()
        }
        onOpenChange={(open) => {
          if (!open) {
            queue.closeEditor();
            setDraft(null);
          }
        }}
        onConfirm={() => {
          if (!draft) return;
          try {
            queue.update(draft);
            setDraft(null);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't save the message.");
          }
        }}
      >
        {draft ? (
          <div className="space-y-3">
            <Textarea
              aria-label="Queued message text"
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
            {draft.skillInvocation ? (
              <p className="text-small text-secondary">
                Skill: {draft.skillInvocation.displayName}
              </p>
            ) : null}
            {draft.attachments.map((attachment) => (
              <div key={attachment.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-small">{attachment.name}</span>
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label={`Remove queued attachment ${attachment.name}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      attachments: draft.attachments.filter((item) => item.id !== attachment.id),
                    })
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="transparent"
                size="small"
                disabled={draftIndex <= 0}
                onClick={() => queue.move(draft.id, draftIndex - 1)}
              >
                <ArrowUp />
                Move up
              </Button>
              <Button
                variant="transparent"
                size="small"
                disabled={draftIndex >= state.messages.length - 1}
                onClick={() => queue.move(draft.id, draftIndex + 1)}
              >
                <ArrowDown />
                Move down
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}
