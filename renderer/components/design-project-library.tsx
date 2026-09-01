import * as React from "react";
import {
  AppWindow,
  Box,
  Copy,
  Download,
  Ellipsis,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import {
  designProjectArtboardLabel,
  designProjectOriginLabel,
  filterDesignProjects,
  type DesignProjectFilter,
  type DesignProjectSummary,
} from "../shared/design-projects";
import { Button, EmptyState, Text } from "./ui";
import "../design-projects.css";

export interface DesignProjectLibraryProps {
  projects: readonly DesignProjectSummary[];
  activeProjectId?: string;
  query: string;
  filter: DesignProjectFilter;
  loading?: boolean;
  error?: string;
  layout?: "rail" | "drawer";
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: DesignProjectFilter) => void;
  onCreateProject: () => void;
  onOpenProject: (projectId: string) => void;
  onRenameProject: (projectId: string) => void;
  onDuplicateProject: (projectId: string) => void;
  onExportProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onRepairProject: (projectId: string) => void;
  onRetry?: () => void;
  onClose?: () => void;
  formatUpdatedAt?: (timestamp: number) => string;
}

const FILTERS: ReadonlyArray<{ id: DesignProjectFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "prototype", label: "Prototype" },
  { id: "connected-app", label: "Connected App" },
];

function defaultFormatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function ProjectActions({
  project,
  onRenameProject,
  onDuplicateProject,
  onExportProject,
  onDeleteProject,
}: Pick<
  DesignProjectLibraryProps,
  "onRenameProject" | "onDuplicateProject" | "onExportProject" | "onDeleteProject"
> & { project: DesignProjectSummary }) {
  return (
    <details className="design-project-menu" onClick={(event) => event.stopPropagation()}>
      <summary aria-label={`More actions for ${project.title}`}>
        <Ellipsis aria-hidden="true" />
      </summary>
      <div role="group" aria-label={`${project.title} actions`}>
        <button type="button" onClick={() => onRenameProject(project.id)}>
          <Pencil aria-hidden="true" /> Rename
        </button>
        <button type="button" onClick={() => onDuplicateProject(project.id)}>
          <Copy aria-hidden="true" /> Duplicate
        </button>
        <button type="button" onClick={() => onExportProject(project.id)}>
          <Download aria-hidden="true" /> Export
        </button>
        <button
          type="button"
          className="design-project-menu-danger"
          onClick={() => onDeleteProject(project.id)}
        >
          <Trash2 aria-hidden="true" /> Delete…
        </button>
      </div>
    </details>
  );
}

export function DesignProjectLibrary({
  projects,
  activeProjectId,
  query,
  filter,
  loading = false,
  error,
  layout = "rail",
  onQueryChange,
  onFilterChange,
  onCreateProject,
  onOpenProject,
  onRenameProject,
  onDuplicateProject,
  onExportProject,
  onDeleteProject,
  onRepairProject,
  onRetry,
  onClose,
  formatUpdatedAt = defaultFormatUpdatedAt,
}: DesignProjectLibraryProps) {
  const visibleProjects = React.useMemo(
    () => filterDesignProjects(projects, filter, query),
    [filter, projects, query],
  );
  const titleId = React.useId();
  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && layout === "drawer" && onClose) {
        event.preventDefault();
        onClose();
      }
    },
    [layout, onClose],
  );

  return (
    <aside
      className="design-project-library"
      data-layout={layout}
      aria-labelledby={titleId}
      aria-modal={layout === "drawer" ? false : undefined}
      role={layout === "drawer" ? "dialog" : undefined}
      onKeyDown={onKeyDown}
    >
      <header className="design-project-panel-header">
        <div className="design-project-panel-heading">
          <Text as="h2" variant="strong" id={titleId}>
            Design Projects
          </Text>
          <Text variant="small" color="tertiary">
            Stored locally on this Mac
          </Text>
        </div>
        <div className="design-project-panel-actions">
          <Button size="small" variant="accent" onClick={onCreateProject}>
            <Plus aria-hidden="true" /> New project
          </Button>
          {layout === "drawer" && onClose ? (
            <Button
              iconOnly
              size="small"
              variant="transparent"
              aria-label="Close projects"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </header>

      <div className="design-project-library-controls">
        <label className="design-project-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search design projects</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="Search projects"
          />
        </label>
        <div className="design-project-filter" role="group" aria-label="Filter design projects">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => onFilterChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="design-project-library-body" aria-busy={loading}>
        {loading ? (
          <div className="design-project-loading" role="status">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span>Loading projects…</span>
          </div>
        ) : error ? (
          <EmptyState
            title="Projects unavailable"
            description={error}
            placement="inline"
            className="design-project-empty"
          />
        ) : visibleProjects.length === 0 ? (
          <EmptyState
            title={projects.length === 0 ? "No design projects yet" : "No matching projects"}
            description={
              projects.length === 0
                ? "Start a prototype or connect a local app."
                : "Try another search or filter."
            }
            placement="inline"
            className="design-project-empty"
          />
        ) : (
          <ul className="design-project-list" aria-label="Design projects">
            {visibleProjects.map((project) => {
              const selected = project.id === activeProjectId;
              const needsRepair = project.health === "needs-repair";
              return (
                <li key={project.id} data-health={project.health}>
                  <div className="design-project-row-shell">
                    <button
                      type="button"
                      className="design-project-row"
                      aria-current={selected ? "page" : undefined}
                      onClick={() => onOpenProject(project.id)}
                    >
                      <span className="design-project-origin-icon" aria-hidden="true">
                          {project.connectionState === "connected" ? <AppWindow /> : <Box />}
                      </span>
                      <span className="design-project-row-copy">
                        <strong>{project.title}</strong>
                        <span>
                          {designProjectOriginLabel(
                            project.connectionState,
                            project.hasPrototypeArtboards,
                          )} ·{" "}
                          {designProjectArtboardLabel(project.artboardCount)}
                        </span>
                        <span>Updated {formatUpdatedAt(project.updatedAt)}</span>
                      </span>
                    </button>
                    <ProjectActions
                      project={project}
                      onRenameProject={onRenameProject}
                      onDuplicateProject={onDuplicateProject}
                      onExportProject={onExportProject}
                      onDeleteProject={onDeleteProject}
                    />
                  </div>
                  {needsRepair ? (
                    <div className="design-project-recovery" role="status">
                      <Wrench aria-hidden="true" />
                      <span>{project.recoveryMessage ?? "Some project data needs attention."}</span>
                      <button type="button" onClick={() => onRepairProject(project.id)}>
                        Repair
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {!loading && error && onRetry ? (
          <Button size="small" variant="filled" className="design-project-retry" onClick={onRetry}>
            <RefreshCw aria-hidden="true" /> Try again
          </Button>
        ) : null}
      </div>

      <footer className="design-project-library-footer">
        <FolderOpen aria-hidden="true" />
        <span>Projects stay in Aiden until you explicitly export or continue in a workspace.</span>
      </footer>
    </aside>
  );
}
