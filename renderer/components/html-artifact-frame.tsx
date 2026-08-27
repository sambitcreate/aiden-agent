import * as React from "react";
import { Download, Maximize2 } from "lucide-react";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import { GENERATIVE_UI_IFRAME_SANDBOX } from "../shared/generative-ui";
import { chatsApi } from "../lib/ipc";
import { Button, Dialog, Text } from "./ui";
import { cn } from "../lib/ui-utils";

interface HtmlArtifactFrameError {
  kind: "preview" | "export";
  message: string;
}

function themeTokensFromDocument(): {
  colorScheme: "light" | "dark";
  canvas: string;
  foreground: string;
  secondary: string;
  accent: string;
} {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const hex = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : fallback;
  };
  return {
    colorScheme: root.classList.contains("dark") ? "dark" : "light",
    canvas: hex("--surface-popover", "#f6f7f9"),
    foreground: hex("--text-primary", "#3d3f41"),
    secondary: hex("--text-secondary", "#6b6b68"),
    accent: hex("--accent", "#006ad6"),
  };
}

function HtmlArtifactIframe({
  src,
  title,
  className,
}: {
  src: string;
  title: string;
  className?: string;
}) {
  return (
    <iframe
      title={title}
      sandbox={GENERATIVE_UI_IFRAME_SANDBOX}
      src={src}
      referrerPolicy="no-referrer"
      className={cn("block h-full w-full border-0 bg-control", className)}
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
  const expandedFrameTargetRef = React.useRef<HTMLDivElement | null>(null);

  // A same-title replace keeps the mediaId and only changes the content hash,
  // so the fetch resolves into an in-place iframe navigation. The previous
  // preview stays mounted and interactive until the replacement arrives —
  // clearing src here would flash the placeholder on every replace.
  React.useEffect(() => {
    let cancelled = false;
    void chatsApi
      .htmlArtifactSrcdoc(chatId, artifact.mediaId, themeTokensFromDocument())
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
    if (!expanded) return;
    const section = sectionRef.current;
    const target = expandedFrameTargetRef.current;
    if (!section || !target) return;
    const positionOverTarget = () => {
      const bounds = target.getBoundingClientRect();
      section.style.left = `${bounds.left}px`;
      section.style.top = `${bounds.top}px`;
      section.style.width = `${bounds.width}px`;
      section.style.height = `${bounds.height}px`;
    };
    positionOverTarget();
    const observer = new ResizeObserver(positionOverTarget);
    observer.observe(target);
    window.addEventListener("resize", positionOverTarget);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionOverTarget);
      section.style.removeProperty("left");
      section.style.removeProperty("top");
      section.style.removeProperty("width");
      section.style.removeProperty("height");
    };
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
      className={cn(
        "max-w-[42rem] overflow-hidden rounded-xl border border-separator bg-control",
        expanded && "fixed z-[60] max-w-none rounded-lg",
      )}
      data-html-artifact={artifact.mediaId}
    >
      <header
        className={cn(
          "flex items-center gap-2 border-b border-separator px-3 py-2",
          expanded && "hidden",
        )}
      >
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
      {error && src && !expanded ? (
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
      <div className={cn(expanded ? "h-full min-h-0" : "h-[22rem] min-h-[12rem]")}>
        {src ? (
          <HtmlArtifactIframe src={src} title={artifact.title} />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <Text variant="small" color="secondary">
              {error?.message ?? "Loading visualization…"}
            </Text>
          </div>
        )}
      </div>
      <Dialog
        open={expanded}
        onOpenChange={setExpanded}
        title={artifact.title}
        confirmHidden
        size="large"
        returnFocus={() => expandTriggerRef.current}
      >
        <div
          ref={expandedFrameTargetRef}
          className="h-[min(70vh,36rem)] overflow-hidden rounded-lg border border-separator"
        >
          {!src ? (
            <Text variant="small" color="secondary">
              {error?.message ?? "Loading visualization…"}
            </Text>
          ) : null}
        </div>
      </Dialog>
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
