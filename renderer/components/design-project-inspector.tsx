import * as React from "react";
import {
  Clock3,
  Code2,
  Copy,
  Download,
  Eye,
  FileDown,
  FolderOpen,
  GitCompareArrows,
  Search,
  X,
} from "lucide-react";
import {
  countDesignProjectSourceMatches,
  designProjectOriginLabel,
  designProjectSourceMatchRanges,
  designProjectSourceLines,
  type DesignProjectDesignerActionSummary,
  type DesignProjectInspectorTab,
  type DesignProjectConnectionState,
  type DesignProjectRevisionSummary,
  type DesignProjectSourceDocument,
} from "../shared/design-projects";
import { Button, EmptyState, Text } from "./ui";
import "../design-projects.css";

export interface DesignProjectInspectorProps {
  selectionTitle?: string;
  connectionState?: DesignProjectConnectionState;
  hasPrototypeArtboards?: boolean;
  activeTab: DesignProjectInspectorTab;
  source?: DesignProjectSourceDocument;
  sourceLoading?: boolean;
  compareSource?: DesignProjectSourceDocument;
  revisions: readonly DesignProjectRevisionSummary[];
  designerActions?: readonly DesignProjectDesignerActionSummary[];
  preview?: React.ReactNode;
  findQuery: string;
  layout?: "rail" | "drawer";
  onTabChange: (tab: DesignProjectInspectorTab) => void;
  onFindChange: (query: string) => void;
  onCopySource: (source: DesignProjectSourceDocument) => void;
  onSaveSource: (source: DesignProjectSourceDocument) => void;
  onExportBundle: () => void;
  canExportBundle?: boolean;
  latestExportName?: string;
  onRevealExport?: () => void;
  onSelectRevision: (lineageId: string, revisionId: string) => void;
  onSelectDesignerAction?: (actionId: string) => void;
  onCompareRevision?: (lineageId: string, revisionId: string) => void;
  onCloseComparison?: () => void;
  onClose?: () => void;
  formatTimestamp?: (timestamp: number) => string;
}

const TABS: ReadonlyArray<{
  id: DesignProjectInspectorTab;
  label: string;
  icon: typeof Eye;
}> = [
  { id: "preview", label: "Preview", icon: Eye },
  { id: "code", label: "Code", icon: Code2 },
  { id: "history", label: "History", icon: Clock3 },
];

function defaultFormatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

type SourceTokenKind = "comment" | "keyword" | "number" | "string" | "title" | "variable";

interface SourceTokenRange {
  start: number;
  end: number;
  kind: SourceTokenKind;
}

const SOURCE_TOKEN_PATTERN =
  /<!--.*?(?:-->|$)|\/\*.*?(?:\*\/|$)|\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|<\/?[A-Za-z][A-Za-z0-9:-]*|\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|yield)\b|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b|--[A-Za-z][\w-]*/gu;

function sourceTokenKind(value: string): SourceTokenKind {
  if (value.startsWith("<!--") || value.startsWith("/*") || value.startsWith("//")) {
    return "comment";
  }
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) return "string";
  if (value.startsWith("<")) return "title";
  if (value.startsWith("--")) return "variable";
  if (/^\d/u.test(value)) return "number";
  return "keyword";
}

function sourceTokenRanges(line: string): SourceTokenRange[] {
  return [...line.matchAll(SOURCE_TOKEN_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    kind: sourceTokenKind(match[0]),
  }));
}

function HighlightedSourceLine({ line, query }: { line: string; query: string }) {
  if (!line) return "\u00a0";
  const matches = designProjectSourceMatchRanges(line, query);
  const tokens = sourceTokenRanges(line);
  const boundaries = new Set([0, line.length]);
  for (const [start, end] of matches) {
    boundaries.add(start);
    boundaries.add(end);
  }
  for (const token of tokens) {
    boundaries.add(token.start);
    boundaries.add(token.end);
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  return offsets.slice(0, -1).map((start, index) => {
    const end = offsets[index + 1]!;
    const value = line.slice(start, end);
    const token = tokens.find((candidate) => start >= candidate.start && end <= candidate.end);
    const content = token ? (
      <span className={`design-project-syntax-${token.kind}`}>{value}</span>
    ) : (
      value
    );
    return matches.some(([matchStart, matchEnd]) => start >= matchStart && end <= matchEnd) ? (
      <mark key={`${start}-${end}`}>{content}</mark>
    ) : (
      <React.Fragment key={`${start}-${end}`}>{content}</React.Fragment>
    );
  });
}

export function DesignProjectInspector({
  selectionTitle,
  connectionState,
  hasPrototypeArtboards = false,
  activeTab,
  source,
  sourceLoading = false,
  compareSource,
  revisions,
  designerActions = [],
  preview,
  findQuery,
  layout = "rail",
  onTabChange,
  onFindChange,
  onCopySource,
  onSaveSource,
  onExportBundle,
  canExportBundle = true,
  latestExportName,
  onRevealExport,
  onSelectRevision,
  onSelectDesignerAction,
  onCompareRevision,
  onCloseComparison,
  onClose,
  formatTimestamp = defaultFormatTimestamp,
}: DesignProjectInspectorProps) {
  const titleId = React.useId();
  const findRef = React.useRef<HTMLInputElement | null>(null);
  const sourceLines = React.useMemo(
    () => (source ? designProjectSourceLines(source.content) : []),
    [source],
  );
  const findMatches = React.useMemo(
    () => (source ? countDesignProjectSourceMatches(source.content, findQuery) : 0),
    [findQuery, source],
  );

  const moveTab = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, tab: DesignProjectInspectorTab) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = TABS.findIndex((item) => item.id === tab);
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? TABS.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
      const next = TABS[nextIndex]!;
      onTabChange(next.id);
      document.getElementById(`${titleId}-${next.id}-tab`)?.focus();
    },
    [onTabChange, titleId],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && layout === "drawer" && onClose) {
        event.preventDefault();
        onClose();
        return;
      }
      if (activeTab !== "code" || !source) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        findRef.current?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        onSaveSource(source);
      }
    },
    [activeTab, layout, onClose, onSaveSource, source],
  );

  return (
    <aside
      className="design-project-inspector"
      data-layout={layout}
      aria-labelledby={titleId}
      aria-modal={layout === "drawer" ? false : undefined}
      role={layout === "drawer" ? "dialog" : undefined}
      onKeyDown={onKeyDown}
    >
      <header className="design-project-panel-header">
        <div className="design-project-panel-heading">
          <Text as="h2" variant="strong" id={titleId} truncate>
            {selectionTitle ?? "Inspector"}
          </Text>
          <Text variant="small" color="tertiary">
            {connectionState
              ? designProjectOriginLabel(connectionState, hasPrototypeArtboards)
              : "Select an artboard to inspect"}
          </Text>
        </div>
        <div className="design-project-panel-actions">
          {latestExportName && onRevealExport ? (
            <Button
              size="small"
              variant="transparent"
              onClick={onRevealExport}
              title={`Reveal ${latestExportName}`}
            >
              <FolderOpen aria-hidden="true" /> Reveal
            </Button>
          ) : null}
          <Button
            size="small"
            variant="filled"
            onClick={onExportBundle}
            disabled={!canExportBundle}
            title={canExportBundle ? undefined : "Select a generated revision to export a bundle"}
          >
            <Download aria-hidden="true" /> Export bundle
          </Button>
          {layout === "drawer" && onClose ? (
            <Button
              iconOnly
              size="small"
              variant="transparent"
              aria-label="Close inspector"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </header>

      <div className="design-project-tabs" role="tablist" aria-label="Design inspector views">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={`${titleId}-${tab.id}-tab`}
              type="button"
              role="tab"
              tabIndex={selected ? 0 : -1}
              aria-selected={selected}
              aria-controls={`${titleId}-${tab.id}-panel`}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => moveTab(event, tab.id)}
            >
              <Icon aria-hidden="true" /> {tab.label}
            </button>
          );
        })}
      </div>

      <section
        id={`${titleId}-preview-panel`}
        role="tabpanel"
        aria-labelledby={`${titleId}-preview-tab`}
        hidden={activeTab !== "preview"}
        className="design-project-inspector-panel design-project-preview-panel"
      >
        {selectionTitle && preview ? (
          preview
        ) : (
          <EmptyState
            title={selectionTitle ? "Preview unavailable" : "Nothing selected"}
            description={
              selectionTitle
                ? "Choose an available revision or reload its preview."
                : "Select an artboard on the canvas to preview it."
            }
          />
        )}
      </section>

      <section
        id={`${titleId}-code-panel`}
        role="tabpanel"
        aria-labelledby={`${titleId}-code-tab`}
        hidden={activeTab !== "code"}
        className="design-project-inspector-panel design-project-code-panel"
      >
        {source ? (
          <>
            {compareSource ? (
              <section
                className="design-project-comparison"
                aria-label={`Compare ${compareSource.revisionLabel} with ${source.revisionLabel}`}
              >
                <header>
                  <div>
                    <Text as="h3" variant="small-strong">
                      Revision comparison
                    </Text>
                    <Text variant="small" color="tertiary">
                      {compareSource.revisionLabel} → {source.revisionLabel}
                    </Text>
                  </div>
                  {onCloseComparison ? (
                    <Button
                      iconOnly
                      size="small"
                      variant="transparent"
                      aria-label="Close revision comparison"
                      onClick={onCloseComparison}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  ) : null}
                </header>
                <div className="design-project-comparison-grid">
                  {[
                    {
                      id: "comparison-base",
                      label: compareSource.revisionLabel,
                      content: compareSource.content,
                    },
                    {
                      id: "comparison-current",
                      label: source.revisionLabel,
                      content: source.content,
                    },
                  ].map(({ id, label, content }) => (
                    <div key={id}>
                      <strong>{label}</strong>
                      <pre tabIndex={0}>
                        <code>{content}</code>
                      </pre>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <div className="design-project-code-toolbar">
              <label className="design-project-code-find">
                <Search aria-hidden="true" />
                <span className="sr-only">Find in source</span>
                <input
                  ref={findRef}
                  type="search"
                  value={findQuery}
                  onChange={(event) => onFindChange(event.currentTarget.value)}
                  placeholder="Find"
                />
                <span role="status" aria-live="polite">
                  {findQuery.trim() ? `${findMatches} found` : ""}
                </span>
              </label>
              <div className="design-project-code-actions">
                <Button size="small" variant="transparent" onClick={() => onCopySource(source)}>
                  <Copy aria-hidden="true" /> Copy source
                </Button>
                {source.language === "html" ? (
                  <Button size="small" variant="transparent" onClick={() => onSaveSource(source)}>
                    <FileDown aria-hidden="true" /> Save HTML
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="design-project-code-meta" aria-label="Source details">
              <code>{source.filename}</code>
              <span>{source.language}</span>
              <span>{source.byteSize.toLocaleString()} bytes</span>
              <span>{source.revisionLabel}</span>
              <span title={source.contentHash}>Hash {source.contentHash.slice(0, 12)}</span>
            </div>
            <div
              className="design-project-source"
              tabIndex={0}
              aria-label={`${source.filename} source code`}
            >
              <ol>
                {sourceLines.map((line, index) => (
                  <li key={`${index}-${line}`}>
                    <span className="design-project-line-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <code>
                      <HighlightedSourceLine line={line} query={findQuery} />
                    </code>
                  </li>
                ))}
              </ol>
            </div>
            <footer className="design-project-source-footer">
              <span>{source.provenance}</span>
              <span>
                {source.readOnly
                  ? "Read-only canonical source"
                  : "Read-only workspace source · Designer Action required"}
              </span>
            </footer>
          </>
        ) : sourceLoading ? (
          <div role="status" aria-live="polite">
            <EmptyState
              title="Loading workspace source…"
              description="Reading the exact connected element as a read-only source view. Changes require a Designer Action."
            />
          </div>
        ) : (
          <EmptyState
            title="Source unavailable"
            description="Select a generated revision or an authorized connected-app source file."
          />
        )}
      </section>

      <section
        id={`${titleId}-history-panel`}
        role="tabpanel"
        aria-labelledby={`${titleId}-history-tab`}
        hidden={activeTab !== "history"}
        className="design-project-inspector-panel design-project-history-panel"
      >
        {revisions.length > 0 || designerActions.length > 0 ? (
          <div className="design-project-history-sections">
            {revisions.length > 0 ? (
              <section aria-labelledby={`${titleId}-generated-history-title`}>
                <Text as="h3" variant="small-strong" id={`${titleId}-generated-history-title`}>
                  Generated revisions
                </Text>
                <ol aria-label="Generated design revision history">
                  {revisions.map((revision) => (
                    <li
                      key={`${revision.lineageId}:${revision.id}`}
                      data-lineage-id={revision.lineageId}
                    >
                      <button
                        type="button"
                        className="design-project-revision"
                        aria-current={revision.active ? "true" : undefined}
                        onClick={() => onSelectRevision(revision.lineageId, revision.id)}
                      >
                        <Clock3 aria-hidden="true" />
                        <span>
                          <strong>{revision.label}</strong>
                          <small>{formatTimestamp(revision.createdAt)}</small>
                          <small>
                            {revision.provenance}
                            {revision.model ? ` · ${revision.model}` : ""}
                          </small>
                        </span>
                      </button>
                      {onCompareRevision && !revision.active ? (
                        <button
                          type="button"
                          className="design-project-compare"
                          aria-label={`Compare ${revision.label}`}
                          onClick={() => onCompareRevision(revision.lineageId, revision.id)}
                        >
                          <GitCompareArrows aria-hidden="true" /> Compare
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            {designerActions.length > 0 ? (
              <section aria-labelledby={`${titleId}-designer-actions-title`}>
                <div className="design-project-history-heading">
                  <Text as="h3" variant="small-strong" id={`${titleId}-designer-actions-title`}>
                    Designer Actions
                  </Text>
                  <span>Project and preview</span>
                </div>
                <Text
                  as="p"
                  variant="small"
                  color="tertiary"
                  className="design-project-history-note"
                >
                  Project-backed actions survive restart. Live preview actions remain separate from
                  immutable Design revisions.
                </Text>
                <ol aria-label="Designer Actions">
                  {designerActions.map((action) => (
                    <li key={action.id}>
                      <button
                        type="button"
                        className="design-project-revision"
                        onClick={() => onSelectDesignerAction?.(action.id)}
                        disabled={!onSelectDesignerAction}
                      >
                        <GitCompareArrows aria-hidden="true" />
                        <span>
                          <strong>{action.label}</strong>
                          <small>{formatTimestamp(action.createdAt)}</small>
                          <small>
                            {action.status}
                            {action.fileLabel ? ` · ${action.fileLabel}` : ""}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </div>
        ) : (
          <EmptyState
            title="No saved revisions"
            description="Generated revisions will appear here. Connected-app Designer Actions remain session-only until their history is durable."
          />
        )}
      </section>
    </aside>
  );
}
