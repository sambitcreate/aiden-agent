import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Check, ChevronRight, Copy, MousePointer2, X } from "lucide-react";
import {
  formatGrabbedElementsForPrompt,
  grabbedElementThumbnailId,
  type GrabbedElementContextV1,
  type GrabbedElementFramework,
  type GrabbedElementSourceLocation,
} from "../shared/browser-element-grab";
import type { Attachment } from "../lib/types";
import { cn } from "../lib/ui-utils";
import { returnFocus } from "../lib/focus-return";
import { useCollapsibleBody } from "../lib/use-collapsible-body";
import { inlineImageSource } from "./message-attachments";
import { Badge, Button, Popover, PopoverContent, Text, toast } from "./ui";

/** Hover preview timing: rest before opening and grace before closing. */
export const GRAB_POPOVER_OPEN_DELAY_MS = 250;
export const GRAB_POPOVER_CLOSE_DELAY_MS = 140;

const FRAMEWORK_LABELS: Record<GrabbedElementFramework, string> = {
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  preact: "Preact",
  solid: "Solid",
  angular: "Angular",
  dom: "HTML / DOM",
};

export function formatGrabbedSourceLocation(source: GrabbedElementSourceLocation): string {
  let out = source.filePath;
  if (source.line !== undefined) {
    out += `:${source.line}`;
    if (source.column !== undefined) out += `:${source.column}`;
  }
  return out;
}

export function formatGrabbedComponentHierarchy(element: GrabbedElementContextV1): string | null {
  const stack = element.componentStack;
  if (stack && stack.length > 0) {
    const formatFrame = (frame: (typeof stack)[number]) =>
      frame.environment === "server" ? `${frame.name} (Server)` : frame.name;
    const [head, ...ancestors] = stack;
    if (!head) return null;
    if (ancestors.length === 0) return formatFrame(head);
    return `${formatFrame(head)} in ${ancestors.map(formatFrame).join(" › ")}`;
  }
  return element.componentName ?? null;
}

interface DetailRow {
  id: string;
  label: string;
  content: React.ReactNode;
}

function buildDetailRows(
  element: GrabbedElementContextV1,
  hasComponentHierarchy: boolean,
): DetailRow[] {
  const rows: DetailRow[] = [];

  if (element.source) {
    const formatted = formatGrabbedSourceLocation(element.source);
    rows.push({
      id: "source",
      label: "Source",
      content: (
        <span
          className="block select-text break-all font-mono text-mini text-primary"
          title={formatted}
        >
          {formatted}
        </span>
      ),
    });
  }

  rows.push({
    id: "framework",
    label: "Framework",
    content: (
      <Badge color="gray" className="h-5 px-1.5 text-mini">
        {FRAMEWORK_LABELS[element.framework]}
      </Badge>
    ),
  });

  if (hasComponentHierarchy) {
    rows.push({
      id: "selector",
      label: "Selector",
      content: (
        <span className="block select-text break-all font-mono text-mini text-secondary">
          {element.selector}
          {element.inIframe ? " (iframe)" : ""}
        </span>
      ),
    });
  }

  const { x, y, width, height } = element.boundingBox;
  rows.push({
    id: "size",
    label: "Size",
    content: (
      <span className="block select-text font-mono text-mini text-secondary">
        {Math.round(width)} × {Math.round(height)} px at ({Math.round(x)}, {Math.round(y)})
      </span>
    ),
  });

  if (element.pageUrl) {
    rows.push({
      id: "page",
      label: "Page",
      content: (
        <span
          className="block select-text break-all text-mini text-secondary"
          title={element.pageUrl}
        >
          {element.pageTitle ? `${element.pageTitle} — ${element.pageUrl}` : element.pageUrl}
        </span>
      ),
    });
  }

  if (element.props && Object.keys(element.props).length > 0) {
    const entries = Object.entries(element.props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    rows.push({
      id: "props",
      label: "Props",
      content: (
        <span className="block select-text break-all font-mono text-mini text-secondary">
          {entries
            .map(
              ([key, value]) =>
                `${key}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`,
            )
            .join(", ")}
        </span>
      ),
    });
  }

  if (element.computedStyles && Object.keys(element.computedStyles).length > 0) {
    const entries = Object.entries(element.computedStyles).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    rows.push({
      id: "styles",
      label: "Styles",
      content: (
        <span className="block select-text break-all font-mono text-mini text-secondary">
          {entries.map(([key, value]) => `${key}: ${value}`).join("; ")}
        </span>
      ),
    });
  }

  if (element.htmlSnippet) {
    rows.push({
      id: "html",
      label: "HTML",
      content: (
        <pre className="m-0 max-h-28 overflow-auto rounded-menu bg-well p-2 font-mono text-mini text-secondary whitespace-pre-wrap break-all">
          {element.htmlSnippet}
        </pre>
      ),
    });
  }

  return rows;
}

function resolveThumbnailSource(
  element: GrabbedElementContextV1,
  attachments: readonly Attachment[] | undefined,
): string | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const targetId = element.thumbnailAttachmentId ?? grabbedElementThumbnailId(element.id);
  const match = attachments.find((attachment) => attachment.id === targetId);
  return match ? inlineImageSource(match) : undefined;
}

export interface GrabbedElementChipProps {
  element: GrabbedElementContextV1;
  attachments?: readonly Attachment[];
  mode?: "composer" | "transcript";
  disabled?: boolean;
  onRemove?: (elementId: string) => void;
  textOnlyModel?: boolean;
}

export function GrabbedElementChip({
  element,
  attachments,
  mode = "composer",
  disabled = false,
  onRemove,
  textOnlyModel = false,
}: GrabbedElementChipProps) {
  const [open, setOpen] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [thumbnailFailed, setThumbnailFailed] = React.useState(false);

  const pinnedRef = React.useRef(false);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const detailsBodyRef = React.useRef<HTMLDivElement | null>(null);

  const contentId = React.useId();
  const titleId = React.useId();
  const detailsId = React.useId();

  const collapsible = useCollapsibleBody(!detailsOpen, detailsBodyRef);
  const thumbnailSrc = React.useMemo(
    () => (thumbnailFailed ? undefined : resolveThumbnailSource(element, attachments)),
    [attachments, element, thumbnailFailed],
  );
  React.useEffect(() => {
    setThumbnailFailed(false);
  }, [element.id, element.thumbnailAttachmentId]);

  const clearHoverTimer = React.useCallback(() => {
    if (hoverTimerRef.current !== undefined) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      clearHoverTimer();
      if (copyTimerRef.current !== undefined) clearTimeout(copyTimerRef.current);
    };
  }, [clearHoverTimer]);

  const openPopover = React.useCallback(
    (pin: boolean) => {
      clearHoverTimer();
      if (pin) {
        pinnedRef.current = true;
        setPinned(true);
      }
      setOpen(true);
    },
    [clearHoverTimer],
  );

  const pinPopover = React.useCallback(() => {
    clearHoverTimer();
    pinnedRef.current = true;
    setPinned(true);
    setOpen(true);
  }, [clearHoverTimer]);

  const closePopover = React.useCallback(
    (restoreTriggerFocus = false) => {
      clearHoverTimer();
      const closingSurface = contentRef.current;
      pinnedRef.current = false;
      setPinned(false);
      setOpen(false);
      if (restoreTriggerFocus) {
        returnFocus([triggerRef.current], { closing: closingSurface, preventScroll: true });
      }
    },
    [clearHoverTimer],
  );

  const togglePin = React.useCallback(() => {
    if (open && pinnedRef.current) {
      closePopover(false);
    } else {
      openPopover(true);
    }
  }, [closePopover, open, openPopover]);

  const scheduleHoverOpen = React.useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === "touch") return;
      clearHoverTimer();
      if (!open) {
        hoverTimerRef.current = setTimeout(() => {
          openPopover(false);
        }, GRAB_POPOVER_OPEN_DELAY_MS);
      }
    },
    [clearHoverTimer, open, openPopover],
  );

  const scheduleHoverClose = React.useCallback(() => {
    clearHoverTimer();
    if (open && !pinnedRef.current) {
      hoverTimerRef.current = setTimeout(() => {
        if (!pinnedRef.current) closePopover(false);
      }, GRAB_POPOVER_CLOSE_DELAY_MS);
    }
  }, [clearHoverTimer, closePopover, open]);

  const handleCopyContext = React.useCallback(async () => {
    pinPopover();
    const formatted = formatGrabbedElementsForPrompt([element], { includeThumbnailNote: false });
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      if (copyTimerRef.current !== undefined) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy element context.");
    }
  }, [element, pinPopover]);

  const componentHierarchy = React.useMemo(
    () => formatGrabbedComponentHierarchy(element),
    [element],
  );
  const detailRows = React.useMemo(
    () => buildDetailRows(element, Boolean(componentHierarchy)),
    [componentHierarchy, element],
  );
  const canRemove = mode === "composer" && Boolean(onRemove);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) closePopover(false);
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <li
          data-grabbed-element-chip={element.id}
          data-grabbed-element-pinned={pinned ? "true" : undefined}
          className={cn(
            "inline-flex min-h-9 min-w-0 max-w-full items-center rounded-control border-0 text-primary transition-colors duration-(--motion-duration) ease-standard",
            mode === "composer" && "composer-context-chip-enter",
            pinned ? "bg-list-selection" : "bg-control hover:bg-control-hover",
            canRemove && "pr-0.5",
          )}
        >
          <button
            ref={triggerRef}
            type="button"
            data-grabbed-element-trigger={element.id}
            aria-expanded={open}
            aria-controls={open ? contentId : undefined}
            aria-label={`Inspect browser element ${element.label}`}
            className={cn(
              "inline-flex min-h-9 min-w-0 cursor-default items-center gap-1.5 rounded-control border-0 bg-transparent pl-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring",
              canRemove ? "pr-1.5" : "pr-2.5",
            )}
            onPointerEnter={scheduleHoverOpen}
            onPointerLeave={scheduleHoverClose}
            onClick={togglePin}
          >
            <MousePointer2 aria-hidden="true" className="size-3.5 shrink-0 text-accent-text" />
            <span className="max-w-[12rem] truncate font-mono text-small text-primary">
              {element.label}
            </span>
          </button>
          {canRemove ? (
            <button
              type="button"
              disabled={disabled}
              data-grabbed-element-remove={element.id}
              aria-label={`Remove ${element.label}`}
              onClick={() => {
                closePopover(false);
                onRemove?.(element.id);
              }}
              className="grid size-8 shrink-0 cursor-default place-items-center rounded-control border-0 bg-transparent text-tertiary outline-none transition-colors duration-(--motion-duration) ease-standard hover:bg-list-hover hover:text-primary active:bg-list-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-45"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
        </li>
      </PopoverPrimitive.Anchor>
      <PopoverContent
        ref={contentRef}
        id={contentId}
        aria-labelledby={titleId}
        side="top"
        align={mode === "transcript" ? "end" : "start"}
        sideOffset={8}
        collisionPadding={8}
        data-grabbed-element-popover={element.id}
        data-pinned={pinned ? "true" : "false"}
        onOpenAutoFocus={(event) => {
          // Hover previews must never steal keyboard focus from the composer.
          if (!pinnedRef.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        onEscapeKeyDown={() => {
          closePopover(true);
        }}
        onInteractOutside={(event) => {
          if (triggerRef.current?.contains(event.target as Node)) {
            event.preventDefault();
          }
        }}
        onPointerEnter={clearHoverTimer}
        onPointerLeave={scheduleHoverClose}
        className="max-h-[min(70vh,520px)] w-[min(92vw,312px)] overflow-y-auto rounded-popover border-0 bg-popover p-3 text-primary shadow-popover outline-none"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <MousePointer2 aria-hidden="true" className="size-3.5 shrink-0 text-accent-text" />
            <Text id={titleId} variant="small-strong" className="truncate">
              {mode === "composer" ? "Included with your message" : "Included with message"}
            </Text>
          </div>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            aria-label={copied ? "Copied element context" : "Copy element context"}
            title={copied ? "Copied" : "Copy context"}
            onClick={() => void handleCopyContext()}
            className="size-7 text-tertiary hover:text-primary"
          >
            {copied ? (
              <Check aria-hidden="true" className="size-3.5 text-status-green" />
            ) : (
              <Copy aria-hidden="true" className="size-3.5" />
            )}
          </Button>
        </div>

        {thumbnailSrc ? (
          <div className="mt-2.5 flex items-center justify-center overflow-hidden rounded-menu bg-well p-1">
            <img
              src={thumbnailSrc}
              alt={`${element.label} preview`}
              onError={() => setThumbnailFailed(true)}
              className="block max-h-[136px] max-w-full rounded-[4px] object-contain"
            />
          </div>
        ) : null}

        {mode === "composer" && textOnlyModel ? (
          <p
            data-grabbed-element-text-only-note=""
            className="mt-2 rounded-menu bg-well px-2 py-1 text-mini text-secondary"
          >
            Text context only for this model
          </p>
        ) : null}

        <dl className="mt-2.5 grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-small">
          <dt className="text-tertiary">Element</dt>
          <dd className="min-w-0 truncate font-mono text-primary" title={element.label}>
            {element.label}
          </dd>
          {componentHierarchy ? (
            <>
              <dt className="text-tertiary">Component</dt>
              <dd
                className="min-w-0 break-words font-mono text-secondary"
                title={componentHierarchy}
              >
                {componentHierarchy}
              </dd>
            </>
          ) : (
            <>
              <dt className="text-tertiary">Selector</dt>
              <dd className="min-w-0 break-all font-mono text-secondary" title={element.selector}>
                {element.selector}
              </dd>
            </>
          )}
        </dl>

        {detailRows.length > 0 ? (
          <div className="mt-2.5 border-t border-separator pt-2">
            <button
              type="button"
              data-grabbed-element-details-toggle=""
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              onClick={() => {
                const next = !detailsOpen;
                if (next) pinPopover();
                setDetailsOpen(next);
              }}
              className="flex w-full cursor-default items-center gap-1 rounded-menu border-0 bg-transparent px-1 py-1 text-left text-small text-secondary outline-none transition-colors duration-(--motion-duration) ease-standard hover:bg-list-hover hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0 text-tertiary transition-transform duration-(--motion-duration) ease-standard motion-reduce:transition-none",
                  detailsOpen && "rotate-90",
                )}
              />
              <span>
                {detailsOpen
                  ? "Hide details"
                  : `Show ${detailRows.length} more ${detailRows.length === 1 ? "detail" : "details"}`}
              </span>
            </button>
            <div
              id={detailsId}
              ref={detailsBodyRef}
              hidden={collapsible.hidden}
              data-open={collapsible.open ? "true" : "false"}
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-(--motion-duration) ease-standard motion-reduce:transition-none",
                collapsible.open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <dl className="mt-2 grid grid-cols-[76px_minmax(0,1fr)] gap-x-2 gap-y-2 text-small">
                  {detailRows.map((row) => (
                    <React.Fragment key={row.id}>
                      <dt className="text-tertiary">{row.label}</dt>
                      <dd className="min-w-0">{row.content}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export interface GrabbedElementChipsProps {
  elements: readonly GrabbedElementContextV1[];
  attachments?: readonly Attachment[];
  mode?: "composer" | "transcript";
  disabled?: boolean;
  onRemove?: (elementId: string) => void;
  textOnlyModel?: boolean;
  className?: string;
}

export function GrabbedElementChips({
  elements,
  attachments,
  mode = "composer",
  disabled = false,
  onRemove,
  textOnlyModel = false,
  className,
}: GrabbedElementChipsProps) {
  if (elements.length === 0) return null;
  return (
    <div className={cn(mode === "composer" && "mb-1.5 px-1.5", className)}>
      <ul
        aria-label={mode === "composer" ? "Selected browser elements" : "Included browser elements"}
        className={cn("flex flex-wrap gap-1.5", mode === "transcript" && "justify-end")}
      >
        {elements.map((element) => (
          <GrabbedElementChip
            key={element.id}
            element={element}
            attachments={attachments}
            mode={mode}
            disabled={disabled}
            onRemove={onRemove}
            textOnlyModel={textOnlyModel}
          />
        ))}
      </ul>
      {mode === "composer" && textOnlyModel ? (
        <p data-grabbed-elements-text-only-hint="" className="mt-1 px-0.5 text-mini text-tertiary">
          Text context only for this model
        </p>
      ) : null}
    </div>
  );
}
