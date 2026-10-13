import * as React from "react";
import { Copy, Download, Expand, FileImage, FileText, Maximize2 } from "lucide-react";
import type { Attachment } from "../lib/types";
import { cn } from "../lib/ui-utils";
import { imagePixelSize } from "../lib/image-dimensions";
import { isCanonicalRasterImageMimeType } from "../shared/attachment-contract";
import { chatsApi } from "../lib/ipc";
import { Button, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, Dialog, toast } from "./ui";

const EMPTY_FAILED_IMAGE_IDS: ReadonlySet<string> = new Set();

export function inlineImageSource(attachment: Attachment): string | undefined {
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
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-control px-2.5 py-2">
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
        size="full"
        returnFocus={returnFocus}
      >
        {previewSource ? (
          // Natural size up to the viewport: a small image is never upscaled.
          <div className="flex size-full min-h-0 min-w-0 items-center justify-center">
            <img
              src={previewSource}
              alt={preview?.name ?? "Image preview"}
              data-attachment-full-view=""
              onError={() => {
                if (preview) markDecodeFailed(preview);
              }}
              className="block h-auto max-h-full w-auto max-w-full rounded-card object-contain"
            />
          </div>
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

/** Chat-scoped actions for stored images (Save to Downloads, Copy image). */
export interface MessageImageActions {
  chatId: string;
}

export function MessageAttachments({
  attachments,
  role,
  imageActions,
}: {
  attachments: readonly Attachment[];
  role: "user" | "assistant";
  /** Present for a settled assistant response whose images are stored in the chat. */
  imageActions?: MessageImageActions;
}) {
  const controller = React.useContext(MessageAttachmentPreviewContext);
  if (attachments.length === 0) return null;
  const content = <MessageAttachmentsContent attachments={attachments} role={role} imageActions={imageActions} />;
  if (!controller) return <MessageAttachmentPreviewProvider>{content}</MessageAttachmentPreviewProvider>;
  return content;
}

async function saveImageToDownloads(chatId: string, attachment: Attachment): Promise<void> {
  try {
    const saved = await chatsApi.saveImageToDownloads(chatId, attachment.id);
    toast("Saved to Downloads", {
      action: { label: "Show in Finder", onClick: () => void chatsApi.showSavedImage(saved.path).catch(() => undefined) },
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Aiden couldn't save the image.");
  }
}

async function copyImage(chatId: string, attachment: Attachment): Promise<void> {
  try {
    await chatsApi.copyImage(chatId, attachment.id);
    toast("Image copied");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Aiden couldn't copy the image.");
  }
}

/**
 * An assistant image stands alone at its natural shape (within 42rem by
 * 32rem), with its name and actions in a caption row below. Nothing overlays
 * the image; right-click offers the same actions.
 */
function AssistantImage({
  attachment,
  source,
  imageActions,
}: {
  attachment: Attachment;
  source: string;
  imageActions?: MessageImageActions;
}) {
  const controller = React.useContext(MessageAttachmentPreviewContext)!;
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const open = () => {
    if (triggerRef.current) controller.openPreview(attachment, triggerRef.current);
  };
  const chatId = imageActions?.chatId;
  // Reserve the box from the header so a long history never shifts as images
  // decode lazily: natural size, at most the column width and 32rem tall.
  const size = React.useMemo(
    () => (attachment.data ? imagePixelSize(attachment.mimeType, attachment.data) : undefined),
    [attachment.data, attachment.mimeType],
  );
  const box: React.CSSProperties | undefined = size
    ? {
        width: `min(100%, ${size.width}px, calc(32rem * ${size.width / size.height}))`,
        aspectRatio: `${size.width} / ${size.height}`,
      }
    : undefined;
  return (
    <figure className="m-0 flex w-fit min-w-0 max-w-[min(100%,42rem)] flex-col" data-assistant-image={attachment.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            data-attachment-preview-id={attachment.id}
            aria-label={`Open ${attachment.name} preview`}
            className={cn(
              "block max-w-full overflow-hidden rounded-card text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
              size ? "bg-control" : "w-fit min-h-24 min-w-24",
            )}
            style={box}
            onClick={open}
          >
            <img
              src={source}
              alt={attachment.name}
              loading="lazy"
              decoding="async"
              width={size?.width}
              height={size?.height}
              onError={() => controller.markDecodeFailed(attachment)}
              className={size ? "block size-full object-contain" : "block h-auto max-h-[32rem] w-auto max-w-full"}
            />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {chatId ? (
            <>
              <ContextMenuItem onSelect={() => void saveImageToDownloads(chatId, attachment)}>
                Save to Downloads
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void copyImage(chatId, attachment)}>Copy image</ContextMenuItem>
            </>
          ) : null}
          <ContextMenuItem onSelect={open}>Open full view</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <figcaption className="mt-1.5 flex min-w-0 items-center gap-1 pl-1">
        <span className="min-w-0 flex-1 truncate text-mini text-tertiary">
          {attachment.name} · {fileSize(attachment.size)}
        </span>
        <Button
          size="small"
          variant="transparent"
          className="px-2"
          onClick={open}
        >
          <Expand aria-hidden="true" className="size-3.5" />
          Expand
        </Button>
        {chatId ? (
          <>
            <Button
              size="small"
              variant="transparent"
              className="px-2"
              onClick={() => void copyImage(chatId, attachment)}
            >
              <Copy aria-hidden="true" className="size-3.5" />
              Copy
            </Button>
            <Button
              size="small"
              variant="transparent"
              className="px-2"
              onClick={() => void saveImageToDownloads(chatId, attachment)}
            >
              <Download aria-hidden="true" className="size-3.5" />
              Save
            </Button>
          </>
        ) : null}
      </figcaption>
    </figure>
  );
}

function MessageAttachmentsContent({
  attachments,
  role,
  imageActions,
}: {
  attachments: readonly Attachment[];
  role: "user" | "assistant";
  imageActions?: MessageImageActions;
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
      {images.length && role === "assistant" ? (
        <div className="flex max-w-full flex-col gap-3">
          {images.map(({ attachment, source }) => (
            <AssistantImage key={attachment.id} attachment={attachment} source={source} imageActions={imageActions} />
          ))}
        </div>
      ) : null}
      {images.length && role === "user" ? (
        <div className="grid max-w-full grid-cols-1 gap-2">
          {images.map(({ attachment, source }) => {
            return (
              <figure key={attachment.id} className="min-w-0">
                <button
                  type="button"
                  data-attachment-preview-id={attachment.id}
                  aria-label={`Open ${attachment.name} preview`}
                  className="group/image relative block max-w-full overflow-hidden rounded-xl bg-control text-left outline-none transition-colors hover:bg-control-hover motion-reduce:transition-none"
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
                    className="block max-h-40 max-w-full object-contain"
                  />
                  <span className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-popover/90 text-secondary opacity-0 shadow-popover transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100 motion-reduce:transition-none">
                    <Maximize2 aria-hidden="true" className="size-3.5" />
                  </span>
                </button>
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
