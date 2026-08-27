import * as React from "react";
import { Download, Maximize2 } from "lucide-react";
import type { ChatHtmlArtifactV1 } from "../shared/chat-artifacts";
import {
  GENERATIVE_UI_IFRAME_SANDBOX,
  GENERATIVE_UI_UNSUPPORTED_DEVICE_COPY,
} from "../shared/generative-ui";
import { chatsApi } from "../lib/ipc";
import { Button, Dialog, Text } from "./ui";
import { cn } from "../lib/ui-utils";

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
  srcdoc,
  title,
  className,
}: {
  srcdoc: string;
  title: string;
  className?: string;
}) {
  return (
    <iframe
      title={title}
      sandbox={GENERATIVE_UI_IFRAME_SANDBOX}
      srcDoc={srcdoc}
      referrerPolicy="no-referrer"
      className={cn("block h-full w-full border-0 bg-control", className)}
    />
  );
}

export function HtmlArtifactFrame({
  chatId,
  artifact,
}: {
  chatId: string;
  artifact: ChatHtmlArtifactV1;
}) {
  const [srcdoc, setSrcdoc] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const expandTriggerRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setSrcdoc(null);
    setError(null);
    void chatsApi
      .htmlArtifactSrcdoc(chatId, artifact.mediaId, themeTokensFromDocument())
      .then((result) => {
        if (cancelled) return;
        if (!result?.srcdoc) {
          setError("This visualization is no longer available.");
          return;
        }
        setSrcdoc(result.srcdoc);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Could not load this visualization.");
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.mediaId, chatId]);

  const exportArtifact = React.useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await chatsApi.exportHtmlArtifact(chatId, artifact.mediaId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }, [artifact.mediaId, chatId, exporting]);

  return (
    <section
      className="max-w-[42rem] overflow-hidden rounded-xl border border-separator bg-control"
      data-html-artifact={artifact.mediaId}
    >
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
      <div className="h-[22rem] min-h-[12rem]">
        {srcdoc ? (
          <HtmlArtifactIframe srcdoc={srcdoc} title={artifact.title} />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <Text variant="small" color="secondary">
              {error ?? "Loading visualization…"}
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
        <div className="h-[min(70vh,36rem)] overflow-hidden rounded-lg border border-separator">
          {srcdoc ? (
            <HtmlArtifactIframe srcdoc={srcdoc} title={artifact.title} />
          ) : (
            <Text variant="small" color="secondary">
              {error ?? GENERATIVE_UI_UNSUPPORTED_DEVICE_COPY}
            </Text>
          )}
        </div>
      </Dialog>
    </section>
  );
}

export function HtmlArtifactList({
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
