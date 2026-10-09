import * as React from "react";
import { Download, Maximize2, X } from "lucide-react";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { GENERATIVE_UI_IFRAME_SANDBOX } from "../shared/generative-ui";
import {
  GENERATIVE_UI_THEME_MESSAGE,
  admitGuestPrompt,
  clampInlineVisualHeight,
  parseGuestBridgeMessage,
} from "../shared/generative-ui-bridge";
import { chatsApi } from "../lib/ipc";
import {
  readGenerativeUiTheme,
  subscribeGenerativeUiTheme,
} from "../lib/generative-ui-theme-snapshot";
import { AidenActivityMark } from "./aiden-activity-mark";
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

/** Last height each streaming draft reported, by its public toolCallId. */
const draftHeights = new Map<string, number>();

/** One use only: call-N ids repeat across turns and chats. */
function takeDraftHeight(toolCallId: string): number | undefined {
  const height = draftHeights.get(toolCallId);
  draftHeights.delete(toolCallId);
  return height;
}

export function rememberDraftHeight(toolCallId: string, height: number): void {
  draftHeights.set(toolCallId, height);
  if (draftHeights.size > 64) draftHeights.delete(draftHeights.keys().next().value!);
}

/**
 * Seed the preview main built when it presented this artifact, so the final
 * frame replaces its draft with a loaded document instead of a placeholder.
 */
export function primeInlineVisualPreview(
  chatId: string,
  artifact: ChatHtmlArtifactV1,
  src: string,
): void {
  const key = cacheKey(chatId, artifact.mediaId);
  const height = previewCache.get(key)?.height;
  previewCache.set(key, { id: artifact.id, src, fetchedAt: Date.now(), ...(height ? { height } : {}) });
}

function cachedPreview(chatId: string, artifact: ChatHtmlArtifactV1): CachedPreview | undefined {
  const cached = previewCache.get(cacheKey(chatId, artifact.mediaId));
  if (!cached || cached.id !== artifact.id || Date.now() - cached.fetchedAt > PREVIEW_REUSE_MS) {
    return undefined;
  }
  return cached;
}

function postThemeTo(guest: Window): void {
  const theme = readGenerativeUiTheme();
  guest.postMessage(
    { type: GENERATIVE_UI_THEME_MESSAGE, colorScheme: theme.colorScheme, vars: theme.vars },
    "*",
  );
}

/**
 * The user confirmed a visual's follow-up on Aiden's own chip. Called only
 * from a click on app UI; a visual's request alone never reaches this.
 */
export type GuestPromptHandler = (text: string, mediaId: string) => void;

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
  onGuestFocus,
}: {
  src: string;
  title: string;
  className?: string;
  onEscape?: () => void;
  onHeight?: (height: number) => void;
  /** The guest asked for a follow-up; the host only ever offers a confirmation. */
  onPrompt?: (text: string) => void;
  /** Focus moved into (true) or out of (false) the guest document. */
  onGuestFocus?: (focused: boolean) => void;
}) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const handlers = React.useRef({ onEscape, onHeight, onPrompt, onGuestFocus });
  React.useLayoutEffect(() => {
    handlers.current = { onEscape, onHeight, onPrompt, onGuestFocus };
  }, [onEscape, onHeight, onPrompt, onGuestFocus]);

  React.useEffect(() => {
    // Focus entering a cross-origin frame blurs this window. The iframe never
    // matches :focus-visible, so focus is reported for the host to draw a
    // ring. Focus authorizes nothing: guests can focus themselves.
    let guestFocused = false;
    const setGuestFocused = (next: boolean) => {
      if (guestFocused === next) return;
      guestFocused = next;
      handlers.current.onGuestFocus?.(next);
    };
    const noteFocusEntry = () => {
      if (document.activeElement === frameRef.current) setGuestFocused(true);
    };
    const noteFocusReturn = () => setGuestFocused(false);
    const noteParentFocus = (event: FocusEvent) => {
      if (event.target !== frameRef.current) setGuestFocused(false);
    };
    const receiveMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      const guest = frame?.contentWindow;
      // A detached frame has no window; never let a sourceless message match.
      if (!frame || !guest || event.source !== guest) return;
      const message = parseGuestBridgeMessage(event.data);
      if (!message) return;
      if (message.type === "escape") handlers.current.onEscape?.();
      // A streaming draft never fires load until it completes; the bridge
      // announces itself so the guest is themed from its first paint.
      else if (message.type === "ready") postThemeTo(guest);
      else if (message.type === "resize") handlers.current.onHeight?.(clampInlineVisualHeight(message.height));
      else handlers.current.onPrompt?.(message.text);
    };
    window.addEventListener("blur", noteFocusEntry);
    window.addEventListener("focus", noteFocusReturn);
    document.addEventListener("focusin", noteParentFocus);
    window.addEventListener("message", receiveMessage);
    return () => {
      window.removeEventListener("blur", noteFocusEntry);
      window.removeEventListener("focus", noteFocusReturn);
      document.removeEventListener("focusin", noteParentFocus);
      window.removeEventListener("message", receiveMessage);
    };
  }, []);

  React.useEffect(() => {
    const sendTheme = () => {
      const guest = frameRef.current?.contentWindow;
      if (guest) postThemeTo(guest);
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
  followUpBusy = false,
  placementCallId,
}: {
  chatId: string;
  artifact: ChatHtmlArtifactV1;
  /** A guest asked to send a follow-up; the caller applies the admission policy. */
  onGuestPrompt?: GuestPromptHandler;
  /** The render_artifact call it came from; its draft's height seeds this frame. */
  placementCallId?: string;
  /** A reply is running: confirming adds the follow-up to the draft instead of sending. */
  followUpBusy?: boolean;
}) {
  const [src, setSrc] = React.useState<string | null>(
    () => cachedPreview(chatId, artifact)?.src ?? null,
  );
  const [height, setHeight] = React.useState<number>(
    () =>
      cachedPreview(chatId, artifact)?.height ??
      (placementCallId ? takeDraftHeight(placementCallId) : undefined) ??
      INITIAL_VISUAL_HEIGHT,
  );
  const [error, setError] = React.useState<HtmlArtifactFrameError | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const sectionRef = React.useRef<HTMLElement | null>(null);
  const expandTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const expandedCloseRef = React.useRef<HTMLButtonElement | null>(null);
  const returnFocusRequestedRef = React.useRef(false);
  const expandedTitleId = React.useId();
  const captionTitleId = React.useId();
  const [guestFocused, setGuestFocused] = React.useState(false);
  const closeExpanded = React.useCallback(() => {
    returnFocusRequestedRef.current = true;
    setExpanded(false);
  }, []);

  // A visual's follow-up is only ever an offer: Aiden draws a confirmation
  // under the visual and the user's click on it is what sends.
  const [pendingFollowUp, setPendingFollowUp] = React.useState<string | null>(null);
  const lastFollowUpAtRef = React.useRef<number | undefined>(undefined);
  const offerFollowUp = React.useCallback((text: string) => {
    const now = performance.now();
    const decision = admitGuestPrompt({ text, now, lastAcceptedAt: lastFollowUpAtRef.current });
    if (decision.action !== "confirm") return;
    lastFollowUpAtRef.current = now;
    setPendingFollowUp(decision.text);
  }, []);
  const confirmFollowUp = React.useCallback(() => {
    if (pendingFollowUp === null) return;
    onGuestPrompt?.(pendingFollowUp, artifact.mediaId);
    setPendingFollowUp(null);
  }, [artifact.mediaId, onGuestPrompt, pendingFollowUp]);

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
    const cached = cachedPreview(chatId, artifact);
    if (cached) {
      // A same-title replace primes the new version's preview before this
      // rerender; navigate the mounted iframe to it in place.
      setError(null);
      setSrc(cached.src);
      return;
    }
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
      variant="transparent"
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
      role={expanded ? "dialog" : "figure"}
      aria-modal={expanded || undefined}
      aria-labelledby={expanded ? expandedTitleId : captionTitleId}
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
      ) : null}
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
        data-guest-focused={guestFocused || undefined}
        style={expanded ? undefined : { height }}
      >
        {src ? (
          <HtmlArtifactIframe
            src={src}
            title={artifact.title}
            onEscape={expanded ? closeExpanded : undefined}
            onHeight={recordHeight}
            onPrompt={onGuestPrompt ? offerFollowUp : undefined}
            onGuestFocus={setGuestFocused}
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
      {pendingFollowUp !== null ? (
        // Aiden's own UI, outside the guest: the only way a visual's text is sent.
        <div
          role="group"
          aria-label={`Follow-up suggested by ${artifact.title}`}
          className="aiden-inline-visual-followup"
          data-inline-visual-followup=""
        >
          <Text variant="small" color="secondary" className="min-w-0 flex-1" aria-live="polite">
            <span className="sr-only">Suggested follow-up: </span>
            <span className="line-clamp-3 break-words" title={pendingFollowUp}>
              “{pendingFollowUp}”
            </span>
          </Text>
          <Button size="small" variant="accent" onClick={confirmFollowUp}>
            {followUpBusy ? "Add to draft" : "Send"}
          </Button>
          <Button
            iconOnly
            size="small"
            variant="transparent"
            aria-label="Dismiss follow-up"
            onClick={() => setPendingFollowUp(null)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      {expanded ? null : (
        // A caption below the content, so no control ever covers the guest.
        <div className="aiden-inline-visual-caption" data-inline-visual-caption="">
          <Text
            id={captionTitleId}
            variant="small"
            color="tertiary"
            className="min-w-0 flex-1 truncate"
          >
            {artifact.title}
          </Text>
          <Button
            ref={expandTriggerRef}
            iconOnly
            size="small"
            variant="transparent"
            aria-label={`Expand ${artifact.title}`}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 aria-hidden="true" />
          </Button>
          {exportButton}
        </div>
      )}
    </section>
  );
}

export const HtmlArtifactFrame = React.memo(HtmlArtifactFrameImpl);

/**
 * A visual the model is still writing: its draft preview grows as the tool
 * call streams (model scripts stay blocked), then the presented frame takes
 * its place in the same row.
 */
function HtmlArtifactDraftFrameImpl({
  src,
  title,
  toolCallId,
}: {
  src: string;
  title?: string;
  /** Remembers the draft's height so the presented frame starts at it. */
  toolCallId?: string;
}) {
  const [height, setHeight] = React.useState(INITIAL_VISUAL_HEIGHT);
  const recordHeight = React.useCallback(
    (next: number) => {
      setHeight(next);
      if (toolCallId) rememberDraftHeight(toolCallId, next);
    },
    [toolCallId],
  );
  // A retracted draft must not leave its height for an unrelated later call.
  // The replacing frame reads it while rendering, before this runs.
  React.useEffect(() => {
    if (!toolCallId) return;
    return () => {
      setTimeout(() => draftHeights.delete(toolCallId), 0);
    };
  }, [toolCallId]);
  const label = title ? `Visualizing ${title}` : "Visualizing";
  return (
    <section
      role="figure"
      aria-label={label}
      aria-busy="true"
      className="aiden-inline-visual relative min-w-0 p-0 text-primary"
      data-inline-visual-draft=""
    >
      <div className="aiden-inline-visual-status" aria-hidden="true">
        <AidenActivityMark mark="scan-grid" size={14} />
        <Text variant="small" color="secondary" className="min-w-0 max-w-[16rem] truncate">
          {label}
        </Text>
      </div>
      <div className="aiden-inline-visual-frame" data-inline-visual-frame="" style={{ height }}>
        <HtmlArtifactIframe src={src} title={label} onHeight={recordHeight} />
      </div>
    </section>
  );
}

export const HtmlArtifactDraftFrame = React.memo(HtmlArtifactDraftFrameImpl);

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
