import * as React from "react";
import { FileImage, FileText, Maximize2 } from "lucide-react";
import type { Attachment } from "../lib/types";
import { cn } from "../lib/ui-utils";
import { isCanonicalRasterImageMimeType } from "../shared/attachment-contract";
import { Dialog } from "./ui";

const EMPTY_FAILED_IMAGE_IDS: ReadonlySet<string> = new Set();

function inlineImageSource(attachment: Attachment): string | undefined {
  if (
    attachment.kind !== "image" ||
    !attachment.data ||
    !isCanonicalRasterImageMimeType(attachment.mimeType)
  ) {
    return undefined;
  }
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

function fileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentCard({ attachment }: { attachment: Attachment }) {
  const Icon = attachment.kind === "image" ? FileImage : FileText;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-separator bg-control px-2.5 py-2">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
      <div className="min-w-0">
        <div className="max-w-[14rem] truncate text-small text-primary">{attachment.name}</div>
        <div className="text-mini text-tertiary">{fileSize(attachment.size)}</div>
      </div>
    </div>
  );
}

interface MessageAttachmentPreviewController {
  failedImageIds: ReadonlySet<string>;
  openPreview: (attachment: Attachment, trigger: HTMLButtonElement) => void;
  markDecodeFailed: (attachment: Attachment) => void;
}

const MessageAttachmentPreviewContext = React.createContext<
  MessageAttachmentPreviewController | undefined
>(undefined);

export function resolveAttachmentPreviewTrigger(
  attachmentId: string | undefined,
  preferred: HTMLButtonElement | null,
  candidates: Iterable<HTMLButtonElement>,
): HTMLButtonElement | null {
  if (!attachmentId) return null;
  if (preferred?.isConnected && preferred.dataset.attachmentPreviewId === attachmentId) {
    return preferred;
  }
  for (const candidate of candidates) {
    if (candidate.isConnected && candidate.dataset.attachmentPreviewId === attachmentId) {
      return candidate;
    }
  }
  return null;
}

/** Keeps preview state alive while a streamed gallery hands off to persisted history. */
export function MessageAttachmentPreviewProvider({ children }: React.PropsWithChildren) {
  const [preview, setPreview] = React.useState<Attachment | null>(null);
  const [failedImageIds, setFailedImageIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const previewTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const previewAttachmentIdRef = React.useRef<string | undefined>(undefined);
  const previewSource =
    preview && !failedImageIds.has(preview.id) ? inlineImageSource(preview) : undefined;
  const markDecodeFailed = React.useCallback((attachment: Attachment) => {
    setFailedImageIds((current) => {
      if (current.has(attachment.id)) return current;
      return new Set([...current, attachment.id]);
    });
    setPreview((current) => (current?.id === attachment.id ? null : current));
  }, []);
  const controller = React.useMemo<MessageAttachmentPreviewController>(
    () => ({
      failedImageIds,
      openPreview: (attachment, trigger) => {
        previewTriggerRef.current = trigger;
        previewAttachmentIdRef.current = attachment.id;
        setPreview(attachment);
      },
      markDecodeFailed,
    }),
    [failedImageIds, markDecodeFailed],
  );
  const returnFocus = React.useCallback(() => {
    const candidates: Iterable<HTMLButtonElement> =
      typeof document === "undefined"
        ? []
        : document.querySelectorAll<HTMLButtonElement>("[data-attachment-preview-id]");
    return resolveAttachmentPreviewTrigger(
      previewAttachmentIdRef.current,
      previewTriggerRef.current,
      candidates,
    );
  }, []);

  return (
    <MessageAttachmentPreviewContext.Provider value={controller}>
      {children}
      <Dialog
        open={Boolean(previewSource)}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={preview?.name ?? "Image preview"}
        description={preview ? fileSize(preview.size) : undefined}
        confirmHidden
        size="large"
        returnFocus={returnFocus}
      >
        {previewSource ? (
          <img
            src={previewSource}
            alt={preview?.name ?? "Image preview"}
            onError={() => {
              if (preview) markDecodeFailed(preview);
            }}
            className="mx-auto max-h-[65vh] max-w-full rounded-xl border border-separator bg-control object-contain"
          />
        ) : null}
      </Dialog>
    </MessageAttachmentPreviewContext.Provider>
  );
}

export function partitionMessageAttachments(
  attachments: readonly Attachment[],
  failedImageIds: ReadonlySet<string> = EMPTY_FAILED_IMAGE_IDS,
): {
  images: Array<{ attachment: Attachment; source: string }>;
  files: Attachment[];
} {
  const images: Array<{ attachment: Attachment; source: string }> = [];
  const files: Attachment[] = [];
  for (const attachment of attachments) {
    const source = failedImageIds.has(attachment.id) ? undefined : inlineImageSource(attachment);
    if (source) images.push({ attachment, source });
    else files.push(attachment);
  }
  return { images, files };
}

export function MessageAttachments({
  attachments,
  role,
}: {
  attachments: readonly Attachment[];
  role: "user" | "assistant";
}) {
  const controller = React.useContext(MessageAttachmentPreviewContext);
  if (!controller) {
    return (
      <MessageAttachmentPreviewProvider>
        <MessageAttachmentsContent attachments={attachments} role={role} />
      </MessageAttachmentPreviewProvider>
    );
  }
  return <MessageAttachmentsContent attachments={attachments} role={role} />;
}

function MessageAttachmentsContent({
  attachments,
  role,
}: {
  attachments: readonly Attachment[];
  role: "user" | "assistant";
}) {
  const controller = React.useContext(MessageAttachmentPreviewContext);
  if (!controller) throw new Error("Message attachment preview context is unavailable.");
  const { failedImageIds, markDecodeFailed, openPreview } = controller;
  const { images, files } = React.useMemo(
    () => partitionMessageAttachments(attachments, failedImageIds),
    [attachments, failedImageIds],
  );

  return (
    <div
      className={cn(
        "flex max-w-full flex-col gap-2",
        role === "user" ? "items-end" : "items-start",
      )}
      data-message-attachments={role}
    >
      {images.length ? (
        <div
          className={cn(
            "grid max-w-full gap-2",
            role === "assistant" && "w-full max-w-[42rem]",
            images.length > 1 && role === "assistant" ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {images.map(({ attachment, source }) => {
            return (
              <figure key={attachment.id} className="min-w-0">
                <button
                  type="button"
                  data-attachment-preview-id={attachment.id}
                  aria-label={`Open ${attachment.name} preview`}
                  className={cn(
                    "group/image relative block max-w-full overflow-hidden rounded-xl border border-separator bg-control text-left outline-none transition-colors hover:border-tertiary motion-reduce:transition-none",
                    role === "assistant" && "w-full",
                  )}
                  onClick={(event) => {
                    openPreview(attachment, event.currentTarget);
                  }}
                >
                  <img
                    src={source}
                    alt={attachment.name}
                    loading="lazy"
                    decoding="async"
                    onError={() => markDecodeFailed(attachment)}
                    className={cn(
                      "block max-w-full object-contain",
                      role === "user" ? "max-h-40" : "max-h-[32rem] min-h-28 w-full bg-popover",
                    )}
                  />
                  <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-popover/90 text-secondary opacity-0 shadow-popover transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100 motion-reduce:transition-none">
                    <Maximize2 aria-hidden="true" className="size-3.5" />
                  </span>
                </button>
                {role === "assistant" ? (
                  <figcaption className="mt-1 truncate px-1 text-mini text-tertiary">
                    {attachment.name} · {fileSize(attachment.size)}
                  </figcaption>
                ) : null}
              </figure>
            );
          })}
        </div>
      ) : null}
      {files.length ? (
        <div className={cn("flex flex-wrap gap-2", role === "user" && "justify-end")}>
          {files.map((attachment) => (
            <AttachmentCard key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
