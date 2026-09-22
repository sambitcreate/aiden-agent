import * as React from "react";
import { Download, Maximize2, X } from "lucide-react";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import {
  GENERATIVE_UI_ESCAPE_MESSAGE,
  GENERATIVE_UI_IFRAME_SANDBOX,
} from "../shared/generative-ui";
import {
  DESIGN_PICKER_COMMAND,
  DESIGN_PICKER_SELECTION,
  parseDesignElementSelection,
  type DesignElementSelectionV1,
} from "../shared/design-workspace";
import { chatsApi } from "../lib/ipc";
import { Button, Text } from "./ui";
import { cn } from "../lib/ui-utils";
import { htmlArtifactThemeTokensFromDocument } from "../lib/html-artifact-preview";

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

export function HtmlArtifactIframe({
  src,
  title,
  className,
  onEscape,
  designPicker,
}: {
  src: string;
  title: string;
  className?: string;
  onEscape?: () => void;
  designPicker?: {
    capability: string;
    enabled: boolean;
    selectedSelector?: string;
    onSelect: (selection: DesignElementSelectionV1, additive: boolean) => void;
  };
}) {
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  React.useEffect(() => {
    if (!onEscape && !designPicker) return;
    const receiveMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.data === GENERATIVE_UI_ESCAPE_MESSAGE) {
        onEscape?.();
        return;
      }
      if (
        !designPicker ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== DESIGN_PICKER_SELECTION ||
        event.data.capability !== designPicker.capability
      )
        return;
      const selection = parseDesignElementSelection(event.data.selection);
      if (selection) designPicker.onSelect(selection, event.data.additive === true);
    };
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [designPicker, onEscape]);
  const syncDesignPicker = React.useCallback(() => {
    if (!designPicker) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: DESIGN_PICKER_COMMAND,
        capability: designPicker.capability,
        enabled: designPicker.enabled,
        selectedSelector: designPicker.selectedSelector ?? "",
      },
      "*",
    );
  }, [designPicker]);
  React.useEffect(syncDesignPicker, [syncDesignPicker]);
  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={GENERATIVE_UI_IFRAME_SANDBOX}
      src={src}
      referrerPolicy="no-referrer"
      className={cn("block h-full w-full border-0 bg-control", className)}
      onLoad={syncDesignPicker}
    />
  );
}

function HtmlArtifactFrameImpl({
  chatId,
  artifact,
}: {
  chatId: string;
  artifact: ChatHtmlArtifactV1;
}) {
  const [src, setSrc] = React.useState<string | null>(null);
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

  // A same-title replace keeps the mediaId and only changes the content hash,
  // so the fetch resolves into an in-place iframe navigation. The previous
  // preview stays mounted and interactive until the replacement arrives —
  // clearing src here would flash the placeholder on every replace.
  React.useEffect(() => {
    let cancelled = false;
    void chatsApi
      .htmlArtifactSrcdoc(chatId, artifact.mediaId, htmlArtifactThemeTokensFromDocument())
      .then((result) => {
        if (cancelled) return;
        if (!result?.src) {
          setError({ kind: "preview", message: "This visualization is no longer available." });
          return;
        }
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

  return (
    <section
      ref={sectionRef}
      popover="auto"
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded || undefined}
      aria-labelledby={expanded ? expandedTitleId : undefined}
      className={cn(
        "aiden-html-artifact-popover max-w-[42rem] overflow-hidden rounded-xl border border-separator bg-control p-0 text-primary",
        expanded && "flex max-w-none flex-col rounded-dialog bg-popover shadow-modal",
      )}
      data-html-artifact={artifact.mediaId}
      data-html-artifact-expanded={expanded || undefined}
    >
      {expanded ? (
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-separator px-5 py-3">
          <h2 id={expandedTitleId} className="min-w-0 flex-1 truncate text-heading2 font-semibold">
            {artifact.title}
          </h2>
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
        </header>
      ) : (
        <header className="flex items-center gap-2 border-b border-separator px-3 py-2">
          <Text variant="small-strong" className="min-w-0 flex-1 truncate">
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
        </header>
      )}
      {error && src ? (
        <div
          role="alert"
          className="border-b border-separator bg-control-hover px-3 py-2"
          data-html-artifact-error={error.kind}
        >
          <Text variant="small" color="red">
            {error.kind === "preview"
              ? `Could not refresh this visualization. Showing the previous version. ${error.message}`
              : `Could not export this visualization. ${error.message}`}
          </Text>
        </div>
      ) : null}
      <div className={cn(expanded ? "min-h-0 flex-1" : "h-[22rem] min-h-[12rem]")}>
        {src ? (
          <HtmlArtifactIframe
            src={src}
            title={artifact.title}
            onEscape={expanded ? closeExpanded : undefined}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <Text variant="small" color="secondary">
              {error?.message ?? "Loading visualization…"}
            </Text>
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
