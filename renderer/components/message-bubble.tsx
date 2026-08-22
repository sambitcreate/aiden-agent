// A single chat message. User messages are right-aligned bubbles; assistant
// messages render markdown full-width, native-transcript style.

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Callout, ErrorBoundary, Text } from "./ui";
import { ChevronLeft, ChevronRight, FileText, Sparkles, X } from "lucide-react";
import { Markdown } from "./markdown";
import { StreamingMarkdownReveal } from "./streaming-markdown-reveal";
import { CopyButton } from "./copy-button";
import type { Attachment, ChatMessage } from "../lib/types";
import type { SkillProvenanceV1 } from "../shared/slash-commands";

export interface MessageBubbleProps {
  role: ChatMessage["role"];
  content: string;
  attachments?: Attachment[];
  skill?: SkillProvenanceV1;
  /** Render the assistant reply through the stable streaming reveal path. */
  streaming?: boolean;
  streamComplete?: boolean;
  onStreamHandoffComplete?: () => void;
  /** Split assistant prose renders one whole-response copy action on its tail. */
  showCopy?: boolean;
  copyText?: string;
}

function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.data);
  const files = attachments.filter((attachment) => attachment.kind !== "image" || !attachment.data);
  const [selectedIndex, setSelectedIndex] = React.useState<number | null>(null);
  const selected = selectedIndex === null ? undefined : images[selectedIndex];

  return (
    <>
      {images.length > 0 ? (
        <div className="flex max-w-full gap-2 overflow-x-auto py-1" data-message-image-gallery>
          {images.map((attachment, index) => (
            <button
              key={attachment.id}
              type="button"
              onClick={() => setSelectedIndex(index)}
              className="group/image shrink-0 overflow-hidden rounded-xl outline-none ring-accent/70 focus-visible:ring-2"
              aria-label={`Open ${attachment.name} full screen`}
            >
              <img
                src={`data:${attachment.mimeType};base64,${attachment.data}`}
                alt={attachment.name}
                className="max-h-56 max-w-[min(70vw,360px)] rounded-xl border border-separator object-contain transition-transform duration-[180ms] group-hover/image:scale-[1.01]"
              />
            </button>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {files.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-1.5 rounded-lg border border-separator bg-control px-2.5 py-1.5"
            >
              <FileText className="size-4 shrink-0 text-tertiary" />
              <span className="max-w-[12rem] truncate text-small">{attachment.name}</span>
            </div>
          ))}
        </div>
      ) : null}
      <DialogPrimitive.Root
        open={selected !== undefined}
        onOpenChange={(open) => !open && setSelectedIndex(null)}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm" />
          <DialogPrimitive.Content className="fixed inset-0 z-60 flex items-center justify-center p-8 outline-none">
            <DialogPrimitive.Title className="sr-only">
              {selected?.name ?? "Image preview"}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Full-screen image attachment preview
            </DialogPrimitive.Description>
            {selected ? (
              <img
                src={`data:${selected.mimeType};base64,${selected.data}`}
                alt={selected.name}
                className="max-h-full max-w-full rounded-xl object-contain shadow-modal"
              />
            ) : null}
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                aria-label="Close image preview"
                className="absolute right-6 top-6 grid size-10 place-items-center rounded-full bg-black/50 text-white outline-none ring-white/80 hover:bg-black/70 focus-visible:ring-2"
              >
                <X className="size-5" />
              </button>
            </DialogPrimitive.Close>
            {images.length > 1 && selectedIndex !== null ? (
              <>
                <button
                  type="button"
                  aria-label="Previous image"
                  onClick={() => setSelectedIndex((selectedIndex - 1 + images.length) % images.length)}
                  className="absolute left-6 grid size-10 place-items-center rounded-full bg-black/50 text-white outline-none ring-white/80 hover:bg-black/70 focus-visible:ring-2"
                >
                  <ChevronLeft className="size-5" />
                </button>
                <button
                  type="button"
                  aria-label="Next image"
                  onClick={() => setSelectedIndex((selectedIndex + 1) % images.length)}
                  className="absolute right-6 grid size-10 place-items-center rounded-full bg-black/50 text-white outline-none ring-white/80 hover:bg-black/70 focus-visible:ring-2"
                >
                  <ChevronRight className="size-5" />
                </button>
              </>
            ) : null}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

/** Isolate untrusted model-formatting failures to the individual message. */
export function SafeMessageBubble(props: MessageBubbleProps) {
  return (
    <ErrorBoundary
      fallback={<UnrenderableMessage content={props.content} />}
      resetKey={props.content}
    >
      <MessageBubble {...props} />
    </ErrorBoundary>
  );
}

export function MessageBubble({
  role,
  content,
  attachments,
  skill,
  streaming,
  streamComplete,
  onStreamHandoffComplete,
  showCopy = true,
  copyText,
}: MessageBubbleProps) {
  if (role === "user") {
    return (
      <div className="group flex justify-end">
        <div className="flex max-w-[80%] flex-col items-end gap-2">
          {skill ? (
            <div
              className="flex max-w-full items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/[0.08] px-2 py-1 text-small text-secondary"
              aria-label={`${skill.name}, ${skill.source} skill`}
            >
              <Sparkles aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
              <span className="truncate font-medium text-primary">{skill.name}</span>
              <span className="text-mini capitalize text-tertiary">{skill.source}</span>
            </div>
          ) : null}
          {attachments && attachments.length > 0 ? <MessageAttachments attachments={attachments} /> : null}
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
        {streaming ? (
          <StreamingMarkdownReveal
            content={content}
            complete={streamComplete}
            onHandoffComplete={onStreamHandoffComplete}
          />
        ) : (
          <Markdown content={content} />
        )}
        {attachments && attachments.length > 0 ? (
          <div className={content ? "mt-3" : undefined}>
            <MessageAttachments attachments={attachments} />
          </div>
        ) : null}
        {content && showCopy ? (
          <div
            className={`mt-1 ${streaming && !streamComplete ? "invisible" : ""}`}
            aria-hidden={streaming && !streamComplete}
          >
            <CopyButton
              text={copyText ?? content}
              label="Copy message"
              className="-ml-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Markdown, KaTeX, and highlighting all run over untrusted model output. If one
// message throws, keep the rest of the transcript alive and show its raw text.
function UnrenderableMessage({ content }: { content: string }) {
  return (
    <Callout color="red">
      <Text variant="small-strong" color="red">
        This message could not be formatted
      </Text>
      <Text variant="small" color="secondary" className="mt-0.5 block whitespace-pre-wrap">
        {content}
      </Text>
    </Callout>
  );
}
