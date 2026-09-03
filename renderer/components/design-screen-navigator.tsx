import * as React from "react";
import { Check, Clock3, PanelsTopLeft, Search, X } from "lucide-react";
import { cn } from "../lib/ui-utils";
import {
  designScreenNavigatorTarget,
  filterDesignScreenNavigatorItems,
  invokeDesignScreenNavigatorSelection,
  type DesignScreenNavigatorItem,
  type DesignScreenNavigatorTarget,
} from "../shared/design-screen-navigator";
import { Button, Text } from "./ui";
import "../design-projects.css";

export type {
  DesignScreenNavigatorItem,
  DesignScreenNavigatorRevision,
  DesignScreenNavigatorTarget,
} from "../shared/design-screen-navigator";

export interface DesignScreenNavigatorProps {
  screens: readonly DesignScreenNavigatorItem[];
  unavailableScreens?: readonly { nodeId: string; title: string }[];
  selectedLineageId?: string;
  selectedMediaId?: string;
  query?: string;
  defaultQuery?: string;
  autoFocusSearch?: boolean;
  className?: string;
  onQueryChange?: (query: string) => void;
  onSelectScreen: (target: DesignScreenNavigatorTarget) => void;
  onClose?: () => void;
}

export function DesignScreenNavigator({
  screens,
  unavailableScreens = [],
  selectedLineageId,
  selectedMediaId,
  query,
  defaultQuery = "",
  autoFocusSearch = false,
  className,
  onQueryChange,
  onSelectScreen,
  onClose,
}: DesignScreenNavigatorProps) {
  const [uncontrolledQuery, setUncontrolledQuery] = React.useState(defaultQuery);
  const currentQuery = query ?? uncontrolledQuery;
  const visibleScreens = React.useMemo(
    () => filterDesignScreenNavigatorItems(screens, currentQuery),
    [currentQuery, screens],
  );
  const visibleUnavailableScreens = React.useMemo(() => {
    const normalized = currentQuery.trim().toLocaleLowerCase();
    return normalized
      ? unavailableScreens.filter(({ title }) => title.toLocaleLowerCase().includes(normalized))
      : [...unavailableScreens];
  }, [currentQuery, unavailableScreens]);
  const totalScreens = screens.length + unavailableScreens.length;
  const totalVisible = visibleScreens.length + visibleUnavailableScreens.length;
  const titleId = React.useId();
  const statusId = React.useId();
  const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const updateQuery = React.useCallback(
    (nextQuery: string) => {
      if (query === undefined) setUncontrolledQuery(nextQuery);
      onQueryChange?.(nextQuery);
    },
    [onQueryChange, query],
  );

  const moveFocus = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const lastIndex = visibleScreens.length - 1;
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? lastIndex
            : event.key === "ArrowDown"
              ? (index + 1) % visibleScreens.length
              : (index - 1 + visibleScreens.length) % visibleScreens.length;
      buttonRefs.current[nextIndex]?.focus();
    },
    [visibleScreens.length],
  );

  const handleEscape = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape" || (!currentQuery && !onClose)) return;
      event.preventDefault();
      event.stopPropagation();
      if (currentQuery) {
        updateQuery("");
        return;
      }
      onClose?.();
    },
    [currentQuery, onClose, updateQuery],
  );

  return (
    <aside
      className={cn("design-screen-navigator", className)}
      aria-labelledby={titleId}
      onKeyDown={handleEscape}
    >
      <header className="design-screen-navigator-header">
        <div className="design-project-panel-heading">
          <Text as="h2" variant="strong" id={titleId}>
            Screens
          </Text>
          <Text variant="small" color="tertiary" id={statusId} role="status" aria-live="polite">
            {currentQuery
              ? `${totalVisible} of ${totalScreens} shown`
              : `${totalScreens} saved ${totalScreens === 1 ? "Screen" : "Screens"}`}
          </Text>
        </div>
        {onClose ? (
          <Button
            iconOnly
            size="small"
            variant="transparent"
            aria-label="Close Screens"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </header>

      <label className="design-screen-navigator-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Search Screens</span>
        <input
          type="search"
          value={currentQuery}
          autoFocus={autoFocusSearch}
          onChange={(event) => updateQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" || visibleScreens.length === 0) return;
            event.preventDefault();
            buttonRefs.current[0]?.focus();
          }}
          placeholder="Search Screens"
          aria-describedby={statusId}
        />
      </label>

      <nav className="design-screen-navigator-body" aria-label="Saved Screens">
        {totalVisible > 0 ? (
          <ol>
            {visibleScreens.map((screen, index) => {
              const target = designScreenNavigatorTarget(screen);
              const previewRevision =
                target.mode === "historical" ? screen.previewRevision : undefined;
              const selected =
                screen.lineageId === selectedLineageId &&
                (selectedMediaId === undefined || target.mediaId === selectedMediaId);
              const stateId = `${titleId}-screen-state-${index}`;
              return (
                <li key={`${screen.lineageId}:${screen.nodeId}`}>
                  <button
                    ref={(element) => {
                      buttonRefs.current[index] = element;
                    }}
                    type="button"
                    className="design-screen-navigator-row"
                    aria-current={selected ? "true" : undefined}
                    aria-describedby={stateId}
                    data-selected={selected || undefined}
                    data-node-id={screen.nodeId}
                    data-lineage-id={screen.lineageId}
                    data-media-id={target.mediaId}
                    data-artifact-id={target.artifactId}
                    onClick={() => invokeDesignScreenNavigatorSelection(screen, onSelectScreen)}
                    onKeyDown={(event) => moveFocus(event, index)}
                  >
                    <PanelsTopLeft aria-hidden="true" />
                    <span className="design-screen-navigator-row-copy">
                      <strong>{screen.title}</strong>
                      <span id={stateId} className="design-screen-navigator-revisions">
                        {previewRevision ? (
                          <>
                            <span data-revision-state="preview">
                              <Clock3 aria-hidden="true" /> Previewing {previewRevision.label}
                            </span>
                            <span data-revision-state="current">
                              <Check aria-hidden="true" /> Current {screen.activeRevision.label}
                            </span>
                          </>
                        ) : (
                          <span data-revision-state="current">
                            <Check aria-hidden="true" /> Current {screen.activeRevision.label}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {visibleUnavailableScreens.map((screen) => (
              <li key={screen.nodeId}>
                <div
                  className="design-screen-navigator-row"
                  aria-disabled="true"
                  data-node-id={screen.nodeId}
                  data-screen-state="unavailable"
                >
                  <PanelsTopLeft aria-hidden="true" />
                  <span className="design-screen-navigator-row-copy">
                    <strong>{screen.title}</strong>
                    <span className="design-screen-navigator-revisions">
                      <span>Preview unavailable · recovery needed</span>
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="design-screen-navigator-empty" role="status">
            <Text variant="small-strong">No Screens found</Text>
            <Text as="p" variant="small" color="secondary">
              Try a different Screen name or revision.
            </Text>
          </div>
        )}
      </nav>
    </aside>
  );
}
