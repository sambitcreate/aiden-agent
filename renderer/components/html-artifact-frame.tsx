import * as React from "react";
import { Download, Maximize2, X } from "lucide-react";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { GENERATIVE_UI_IFRAME_SANDBOX } from "../shared/generative-ui";
import {
  GENERATIVE_UI_THEME_MESSAGE,
  clampInlineVisualHeight,
  parseGuestBridgeMessage,
} from "../shared/generative-ui-bridge";
import { chatsApi } from "../lib/ipc";
import {
  readGenerativeUiTheme,
  subscribeGenerativeUiTheme,
} from "../lib/generative-ui-theme-snapshot";
import { Button, Callout, Text } from "./ui";
import { cn } from "../lib/ui-utils";

/** Height before the guest first reports its content size. */
const INITIAL_VISUAL_HEIGHT = 160;
/** Preview tokens live 30 minutes in main; refetch a little before that. */
const PREVIEW_REUSE_MS = 25 * 60 * 1000;

interface CachedPreview {
  id: string;
  src: string;
  height?: number;
  fetchedAt: number;
}

/**
 * Last preview URL and measured height per visual. The live response and the
 * settled message render a visual under different parents, so the iframe
 * remounts at stream handoff; this lets the remount reuse the same document
 * and height without another round trip or a layout jump.
 */
const previewCache = new Map<string, CachedPreview>();

function cacheKey(chatId: string, mediaId: string): string {
  return `${chatId}\u0000${mediaId}`;
}

function cachedPreview(chatId: string, artifact: ChatHtmlArtifactV1): CachedPreview | undefined {
  const cached = previewCache.get(cacheKey(chatId, artifact.mediaId));
  if (!cached || cached.id !== artifact.id || Date.now() - cached.fetchedAt > PREVIEW_REUSE_MS) {
    return undefined;
  }
  return cached;
}

interface HtmlArtifactFrameError {
  kind: "preview" | "export";
  message: string;
}

interface OutsideInteractionState {
  element: HTMLElement;
  inert: boolean;
  ariaHidden: string | null;
}

/** Keep pointer, keyboard, and accessibility navigation inside an expanded artifact. */
function isolateExpandedArtifact(section: HTMLElement): () => void {
  const outside: OutsideInteractionState[] = [];
  let branch: HTMLElement = section;
  let parent = branch.parentElement;
  while (parent) {
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
      outside.push({
        element: sibling,
        inert: sibling.inert,
        ariaHidden: sibling.getAttribute("aria-hidden"),
      });
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }
    branch = parent;
    parent = parent.parentElement;
  }

  const previousOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = "hidden";
  return () => {
    document.documentElement.style.overflow = previousOverflow;
    for (const state of outside) {
      state.element.inert = state.inert;
      if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
      else state.element.setAttribute("aria-hidden", state.ariaHidden);
    }
  };
}

function HtmlArtifactIframe({
  src,
  title,
  className,
  onEscape,
  onHeight,
  onPrompt,
}: {
  src: string;
  title: string;
  className?: string;
  onEscape?: () => void;
  onHeight?: (height: number) => void;
  onPrompt?: (text: string, frameFocused: boolean) => void;
}) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const handlers = React.useRef({ onEscape, onHeight, onPrompt });
  React.useLayoutEffect(() => {
    handlers.current = { onEscape, onHeight, onPrompt };
  }, [onEscape, onHeight, onPrompt]);

  React.useEffect(() => {
    const receiveMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      const guest = frame?.contentWindow;
      // A detached frame has no window; never let a sourceless message match.
      if (!frame || !guest || event.source !== guest) return;
      const message = parseGuestBridgeMessage(event.data);
      if (!message) return;
      if (message.type === "escape") handlers.current.onEscape?.();
      else if (message.type === "resize") handlers.current.onHeight?.(clampInlineVisualHeight(message.height));
      else handlers.current.onPrompt?.(message.text, document.activeElement === frame);
    };
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, []);

  React.useEffect(() => {
    const sendTheme = () => {
      const guest = frameRef.current?.contentWindow;
      if (!guest) return;
      const theme = readGenerativeUiTheme();
      guest.postMessage(
        { type: GENERATIVE_UI_THEME_MESSAGE, colorScheme: theme.colorScheme, vars: theme.vars },
        "*",
      );
    };
    const frame = frameRef.current;
    frame?.addEventListener("load", sendTheme);
    const unsubscribe = subscribeGenerativeUiTheme(sendTheme);
    return () => {
      frame?.removeEventListener("load", sendTheme);
      unsubscribe();
    };
  }, []);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={GENERATIVE_UI_IFRAME_SANDBOX}
      src={src}
      referrerPolicy="no-referrer"
      className={cn("block h-full w-full border-0 bg-transparent", className)}
    />
  );
}

function HtmlArtifactFrameImpl({
  chatId,
  artifact,
  onGuestPrompt,
}: {
  chatId: string;
  artifact: ChatHtmlArtifactV1;
  /** A guest asked to send a follow-up; the caller applies the admission policy. */
  onGuestPrompt?: (text: string, frameFocused: boolean) => void;
}) {
  const [src, setSrc] = React.useState<string | null>(
    () => cachedPreview(chatId, artifact)?.src ?? null,
  );
  const [height, setHeight] = React.useState<number>(
    () => cachedPreview(chatId, artifact)?.height ?? INITIAL_VISUAL_HEIGHT,
  );
  const [error, setError] = React.useState<HtmlArtifactFrameError | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const sectionRef = React.useRef<HTMLElement | null>(null);
  const expandTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const expandedCloseRef = React.useRef<HTMLButtonElement | null>(null);
  const returnFocusRequestedRef = React.useRef(false);
  const expandedTitleId = React.useId();
  const closeExpanded = React.useCallback(() => {
    returnFocusRequestedRef.current = true;
    setExpanded(false);
  }, []);

  const recordHeight = React.useCallback(
    (next: number) => {
      setHeight(next);
      const cached = previewCache.get(cacheKey(chatId, artifact.mediaId));
      if (cached?.id === artifact.id) cached.height = next;
    },
    [artifact.id, artifact.mediaId, chatId],
  );

  // A same-title replace keeps the mediaId and only changes the content hash,
  // so the fetch resolves into an in-place iframe navigation. The previous
  // preview stays mounted and interactive until the replacement arrives —
  // clearing src here would flash the placeholder on every replace.
  React.useEffect(() => {
    if (cachedPreview(chatId, artifact)) return;
    let cancelled = false;
    void chatsApi
      .htmlArtifactSrcdoc(chatId, artifact.mediaId, readGenerativeUiTheme())
      .then((result) => {
        if (cancelled) return;
        if (!result?.src) {
          setError({ kind: "preview", message: "This visualization is no longer available." });
          return;
        }
        previewCache.set(cacheKey(chatId, artifact.mediaId), {
          id: artifact.id,
          src: result.src,
          fetchedAt: Date.now(),
        });
        setError(null);
        setSrc(result.src);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError({
          kind: "preview",
          message: cause instanceof Error ? cause.message : "Could not load this visualization.",
        });
      });
    return () => {
      cancelled = true;
    };
    // `artifact` is read for its id/mediaId only; both are listed.
  }, [artifact.id, artifact.mediaId, chatId]);

  React.useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section || !expanded) return;
    const onToggle = () => {
      if (!section.matches(":popover-open")) closeExpanded();
    };
    section.addEventListener("toggle", onToggle);
    let releaseOutside: () => void = () => undefined;
    let focusFrame: number | undefined;
    try {
      section.showPopover();
      releaseOutside = isolateExpandedArtifact(section);
      focusFrame = requestAnimationFrame(() => expandedCloseRef.current?.focus());
    } catch (cause) {
      closeExpanded();
      setError({
        kind: "preview",
        message: cause instanceof Error ? cause.message : "Could not expand this visualization.",
      });
    }
    return () => {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
      section.removeEventListener("toggle", onToggle);
      releaseOutside();
      if (section.matches(":popover-open")) section.hidePopover();
    };
  }, [closeExpanded, expanded]);

  React.useLayoutEffect(() => {
    if (expanded || !returnFocusRequestedRef.current) return;
    returnFocusRequestedRef.current = false;
    const frame = requestAnimationFrame(() => {
      const trigger = expandTriggerRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded]);

  const exportArtifact = React.useCallback(async () => {
    if (exporting) return;
    setError((current) => (current?.kind === "export" ? null : current));
    setExporting(true);
    try {
      await chatsApi.exportHtmlArtifact(chatId, artifact.mediaId);
    } catch (cause) {
      setError({
        kind: "export",
        message: cause instanceof Error ? cause.message : "Export failed.",
      });
    } finally {
      setExporting(false);
    }
  }, [artifact.mediaId, chatId, exporting]);

  const exportButton = (
    <Button
      iconOnly
      size="small"
      variant={expanded ? "transparent" : "glass"}
      aria-label={`Export ${artifact.title}`}
      disabled={exporting}
      onClick={() => void exportArtifact()}
    >
      <Download aria-hidden="true" />
    </Button>
  );

  return (
    <section
      ref={sectionRef}
      popover="auto"
      role={expanded ? "dialog" : "region"}
      aria-modal={expanded || undefined}
      aria-label={expanded ? undefined : artifact.title}
      aria-labelledby={expanded ? expandedTitleId : undefined}
      className={cn(
        "aiden-html-artifact-popover aiden-inline-visual group/visual relative min-w-0 p-0 text-primary",
        expanded && "flex max-w-none flex-col overflow-hidden rounded-dialog bg-popover shadow-modal",
      )}
      data-html-artifact={artifact.mediaId}
      data-inline-visual={artifact.mediaId}
      data-html-artifact-expanded={expanded || undefined}
    >
      {expanded ? (
        <div className="flex min-h-14 shrink-0 items-center gap-2 border-b border-separator px-5 py-3">
          <h2
            id={expandedTitleId}
            className="min-w-0 flex-1 truncate text-heading2 font-semibold"
          >
            {artifact.title}
          </h2>
          {exportButton}
          <Button
            ref={expandedCloseRef}
            iconOnly
            size="small"
            variant="transparent"
            aria-label={`Close ${artifact.title}`}
            onClick={closeExpanded}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <div className="aiden-inline-visual-toolbar" data-inline-visual-toolbar="">
          <Text variant="small" color="secondary" className="min-w-0 max-w-[16rem] truncate px-1">
            {artifact.title}
          </Text>
          <Button
            ref={expandTriggerRef}
            iconOnly
            size="small"
            variant="glass"
            aria-label={`Expand ${artifact.title}`}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 aria-hidden="true" />
          </Button>
          {exportButton}
        </div>
      )}
      {error && src ? (
        <Callout color="red" role="alert" className="mb-2" data-html-artifact-error={error.kind}>
          <Text variant="small" color="red">
            {error.kind === "preview"
              ? `Could not refresh this visualization. Showing the previous version. ${error.message}`
              : `Could not export this visualization. ${error.message}`}
          </Text>
        </Callout>
      ) : null}
      <div
        className={cn(expanded ? "min-h-0 flex-1" : "aiden-inline-visual-frame")}
        data-inline-visual-frame=""
        style={expanded ? undefined : { height }}
      >
        {src ? (
          <HtmlArtifactIframe
            src={src}
            title={artifact.title}
            onEscape={expanded ? closeExpanded : undefined}
            onHeight={recordHeight}
            onPrompt={onGuestPrompt}
          />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <Text variant="small" color="secondary">
              {error.message}
            </Text>
          </div>
        ) : (
          <div className="h-full w-full rounded-card bg-well" aria-busy="true">
            <span className="sr-only">Loading visualization…</span>
          </div>
        )}
      </div>
    </section>
  );
}

export const HtmlArtifactFrame = React.memo(HtmlArtifactFrameImpl);

function HtmlArtifactListImpl({
  chatId,
  artifacts,
}: {
  chatId: string;
  artifacts: readonly ChatHtmlArtifactV1[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {artifacts.map((artifact) => (
        <HtmlArtifactFrame key={artifact.mediaId} chatId={chatId} artifact={artifact} />
      ))}
    </div>
  );
}

export const HtmlArtifactList = React.memo(HtmlArtifactListImpl);
