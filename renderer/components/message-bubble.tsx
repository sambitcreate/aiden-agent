// A single chat message. User messages are right-aligned bubbles; assistant
// messages render markdown full-width, native-transcript style.

import { Text } from "@glaze/core/components";
import { cn } from "@glaze/core/utils";
import { FileText } from "lucide-react";
import { Markdown } from "./markdown";
import { CopyButton } from "./copy-button";
import type { Attachment, ChatMessage } from "../lib/types";

interface MessageBubbleProps {
  role: ChatMessage["role"];
  content: string;
  attachments?: Attachment[];
  /** Show a blinking caret while streaming an assistant reply. */
  streaming?: boolean;
}

export function MessageBubble({ role, content, attachments, streaming }: MessageBubbleProps) {
  if (role === "user") {
    return (
      <div className="group flex justify-end">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          {attachments && attachments.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-2">
              {attachments.map((a) =>
                a.kind === "image" && a.data ? (
                  <img
                    key={a.id}
                    src={`data:${a.mimeType};base64,${a.data}`}
                    alt={a.name}
                    className="max-h-40 rounded-xl border border-separator object-cover"
                  />
                ) : (
                  <div
                    key={a.id}
                    className="flex items-center gap-1.5 rounded-lg border border-separator bg-control px-2.5 py-1.5"
                  >
                    <FileText className="size-4 shrink-0 text-tertiary" />
                    <span className="max-w-[12rem] truncate text-small">{a.name}</span>
                  </div>
                ),
              )}
            </div>
          ) : null}
          {content ? (
            <div className="rounded-2xl bg-control px-4 py-2.5">
              <Text className="whitespace-pre-wrap break-words">{content}</Text>
            </div>
          ) : null}
          {content ? (
            <CopyButton
              text={content}
              label="Copy message"
              className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex w-full">
      <div className="min-w-0 flex-1">
        <Markdown content={content} />
        {streaming ? (
          <span
            className={cn(
              "inline-block h-4 w-[2px] translate-y-0.5 bg-accent align-middle",
              "animate-pulse",
              content ? "ml-0.5" : "",
            )}
          />
        ) : null}
        {content && !streaming ? (
          <div className="mt-1">
            <CopyButton
              text={content}
              label="Copy message"
              className="-ml-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
