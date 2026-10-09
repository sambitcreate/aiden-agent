import * as React from "react";
import { Copy } from "lucide-react";
import { AIDEN_UI_LIMITS, type AidenUiActionV1, type AidenUiNodeV1, type ChatUiVisualV1 } from "../../shared/aiden-ui/types";
import { evaluate, truthy, type AidenUiScope } from "../../shared/aiden-ui/evaluate";
import { MAX_GUEST_PROMPT_CHARS } from "../../shared/generative-ui-bridge";
import { cn } from "../../lib/ui-utils";
import { Button, Dialog, toast, TooltipProvider } from "../ui";
import { CATALOG_COMPONENTS } from "./components";
import { AidenUiContext, asString, type AidenUiRenderContext } from "./render-context";

/**
 * Draws a native Aiden UI visual: the model's component tree rendered with
 * Aiden's own components. Local interactions (bound inputs, setState) run
 * here without a model call. Follow-ups, copies, and links leave through
 * `onAction`, and a link always asks first.
 */

export type AidenUiAction =
  | { kind: "send"; text: string }
  | { kind: "copy"; text: string }
  | { kind: "open"; url: string };

function parseData(dataJson: string | undefined): Record<string, unknown> {
  if (!dataJson) return {};
  try {
    const parsed = JSON.parse(dataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function initialState(visual: ChatUiVisualV1): Record<string, unknown> {
  return { ...(visual.state ?? {}) };
}

function renderNodes(nodes: readonly AidenUiNodeV1[] | undefined, ctx: AidenUiRenderContext): React.ReactNode {
  if (!nodes?.length) return null;
  return nodes.map((node) => renderNode(node, ctx, node.k));
}

function renderNode(node: AidenUiNodeV1, ctx: AidenUiRenderContext, key: string): React.ReactNode {
  if (node.t === "#text") return <React.Fragment key={key}>{node.s}</React.Fragment>;
  if (node.t === "#expr") return <React.Fragment key={key}>{node.e ? asString(evaluate(node.e, ctx.scope)) : null}</React.Fragment>;
  if (node.t === "If") {
    const test = node.p?.test;
    const show = test && "op" in test ? truthy(evaluate(test, ctx.scope)) : false;
    return show ? <React.Fragment key={key}>{ctx.renderChildren(node.c)}</React.Fragment> : null;
  }
  if (node.t === "Each") {
    const source = node.p?.in;
    const list = source && "op" in source ? evaluate(source, ctx.scope) : undefined;
    if (!Array.isArray(list)) return null;
    const asProp = node.p?.as;
    const name = (asProp && "op" in asProp ? asString(evaluate(asProp, ctx.scope)) : "") || "item";
    return (
      <React.Fragment key={key}>
        {list.slice(0, AIDEN_UI_LIMITS.eachIterations).map((item, index) => (
          <React.Fragment key={index}>
            {ctx.renderChildren(node.c, { ...ctx.scope, vars: { ...ctx.scope.vars, [name]: item, [`${name}Index`]: index } })}
          </React.Fragment>
        ))}
      </React.Fragment>
    );
  }
  const Component = CATALOG_COMPONENTS[node.t];
  if (!Component) return null;
  return <Component key={key} node={node} ctx={ctx} />;
}

export function AidenUiBlock({
  visual,
  draft = false,
  onAction,
  onStateChange,
  attachments,
}: {
  visual: ChatUiVisualV1;
  /** A visual still being written: shown, but inert. */
  draft?: boolean;
  onAction?: (action: AidenUiAction) => void;
  /** Called with the full local state after every change (callers debounce). */
  onStateChange?: (state: Record<string, unknown>) => void;
  /** The message's image attachments, for `<Image attachment="…">`. */
  attachments?: readonly { id: string; mimeType: string; data?: string }[];
}) {
  const [state, setLocalState] = React.useState<Record<string, unknown>>(() => initialState(visual));
  const [pendingUrl, setPendingUrl] = React.useState<string | null>(null);
  const data = React.useMemo(() => parseData(visual.dataJson), [visual.dataJson]);
  const onActionRef = React.useRef(onAction);
  const onStateChangeRef = React.useRef(onStateChange);
  React.useLayoutEffect(() => {
    onActionRef.current = onAction;
    onStateChangeRef.current = onStateChange;
  }, [onAction, onStateChange]);

  const setState = React.useCallback(
    (key: string, value: unknown) => {
      if (draft) return;
      setLocalState((current) => {
        if (Object.is(current[key], value)) return current;
        const next = { ...current, [key]: value };
        onStateChangeRef.current?.(next);
        return next;
      });
    },
    [draft],
  );

  const copyText = React.useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast.success("Copied"),
      () => toast.error("Could not copy"),
    );
  }, []);

  const runAction = React.useCallback(
    (action: AidenUiActionV1, scope: AidenUiScope) => {
      if (draft) return;
      switch (action.act) {
        case "set":
          setState(action.key, evaluate(action.value, scope));
          return;
        case "send": {
          const text = asString(evaluate(action.text, scope)).trim();
          if (text && text.length <= MAX_GUEST_PROMPT_CHARS) onActionRef.current?.({ kind: "send", text });
          return;
        }
        case "copy": {
          const text = asString(evaluate(action.text, scope));
          if (!text) return;
          copyText(text);
          onActionRef.current?.({ kind: "copy", text });
          return;
        }
        case "open": {
          const url = asString(evaluate(action.url, scope));
          try {
            if (new URL(url).protocol === "https:") setPendingUrl(url);
          } catch {
            // Not a URL: nothing to open.
          }
          return;
        }
      }
    },
    [copyText, draft, setState],
  );

  const attachmentSource = React.useCallback(
    (id: string) => {
      const match = attachments?.find((attachment) => attachment.id === id);
      if (!match?.data || !/^image\/(png|jpeg|gif|webp)$/u.test(match.mimeType)) return undefined;
      return `data:${match.mimeType};base64,${match.data}`;
    },
    [attachments],
  );

  const ctx = React.useMemo(() => {
    const make = (scope: AidenUiScope): AidenUiRenderContext => {
      const context: AidenUiRenderContext = {
        scope,
        draft,
        state,
        setState,
        runAction,
        attachmentSource,
        renderChildren: (nodes, childScope) => renderNodes(nodes, childScope ? make(childScope) : context),
      };
      return context;
    };
    return make({ vars: { ...data, ...state }, locale: navigator.language || "en-US" });
  }, [attachmentSource, data, draft, runAction, setState, state]);

  let host = "";
  try {
    host = pendingUrl ? new URL(pendingUrl).host : "";
  } catch {
    host = "";
  }

  return (
    <section
      role="figure"
      aria-label={visual.title}
      aria-busy={draft || undefined}
      className="aiden-inline-visual relative min-w-0 p-0 text-primary"
      data-aiden-ui={visual.id}
      data-layout={visual.layout === "wide" ? "wide" : undefined}
    >
      <TooltipProvider>
        <AidenUiContext.Provider value={ctx}>
          <div className={cn("flex min-w-0 flex-col gap-3", draft && "opacity-80")} inert={draft || undefined}>
            {ctx.renderChildren(visual.tree.c)}
          </div>
        </AidenUiContext.Provider>
      </TooltipProvider>
      {draft ? null : (
        <div className="aiden-inline-visual-caption">
          <span className="min-w-0 flex-1 truncate text-small text-tertiary">{visual.title}</span>
          <Button
            iconOnly
            size="small"
            variant="transparent"
            aria-label={`Copy ${visual.title} as text`}
            onClick={() => copyText(visual.fallbackText)}
          >
            <Copy aria-hidden="true" />
          </Button>
        </div>
      )}
      <Dialog
        open={pendingUrl !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUrl(null);
        }}
        title="Open link?"
        description={`This visual wants to open ${host} in your browser.`}
        confirmLabel="Open"
        cancelLabel="Cancel"
        onConfirm={() => {
          if (pendingUrl) {
            window.open(pendingUrl, "_blank", "noopener,noreferrer");
            onActionRef.current?.({ kind: "open", url: pendingUrl });
          }
          setPendingUrl(null);
        }}
      >
        <p className="m-0 break-all text-small text-secondary">{pendingUrl}</p>
      </Dialog>
    </section>
  );
}
