import * as React from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Plus, Settings, UserRound } from "lucide-react";
import { designerApi } from "../lib/ipc";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import type { ShellMode } from "../lib/shell-mode";
import type {
  DesignProjectDeletePlanV1,
  DesignProjectFilter,
  DesignProjectRecordSummaryV1,
  DesignProjectSnapshotV1,
} from "../shared/design-projects";
import { DesignProjectLibrary } from "./design-project-library";
import { WorkspaceModeSwitcher } from "./workspace-mode-switcher";
import {
  AlertDialog,
  Dialog,
  Sidebar,
  SidebarFooter,
  SidebarListItem,
  SplitView,
  toast,
  useSplitViewSidebar,
} from "./ui";

export function DesignProjectSidebar({
  activeProjectId,
  projectUpdate,
  mode,
  onModeChange,
  onProjectChange,
  onProjectUnavailable,
}: {
  activeProjectId?: string;
  projectUpdate?: DesignProjectSnapshotV1;
  mode: ShellMode;
  onModeChange: (mode: ShellMode) => void;
  onProjectChange: (project: DesignProjectSnapshotV1) => void;
  onProjectUnavailable: (projectId: string) => void;
}) {
  const navigate = useNavigate();
  const { closeIfCompact } = useSplitViewSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const appendReconciliationRequired = useAppendReconciliationRequired();
  const [projects, setProjects] = React.useState<DesignProjectRecordSummaryV1[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<DesignProjectFilter>("all");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createBusy, setCreateBusy] = React.useState(false);
  const [title, setTitle] = React.useState("Untitled Design");
  const [renameProjectId, setRenameProjectId] = React.useState<string>();
  const [renameTitle, setRenameTitle] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);
  const [duplicateBusyId, setDuplicateBusyId] = React.useState<string>();
  const [deletePlan, setDeletePlan] = React.useState<DesignProjectDeletePlanV1>();
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await designerApi.listProjects());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Design Projects are unavailable.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!projectUpdate) return;
    const artboards = projectUpdate.canvas.nodes.filter(({ kind }) => kind === "artboard");
    const summary: DesignProjectRecordSummaryV1 = {
      id: projectUpdate.id,
      revision: projectUpdate.revision,
      title: projectUpdate.title,
      chatId: projectUpdate.chatId,
      ...(projectUpdate.workspaceId ? { workspaceId: projectUpdate.workspaceId } : {}),
      connectionState: projectUpdate.connectionState,
      hasPrototypeArtboards: artboards.some(
        ({ canonicalOrigin }) => canonicalOrigin === "generated-artifact",
      ),
      updatedAt: projectUpdate.updatedAt,
      artboardCount: artboards.length,
      health: "ready",
    };
    setProjects((current) =>
      [summary, ...current.filter(({ id }) => id !== summary.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    );
  }, [projectUpdate]);

  const openProject = React.useCallback(
    (projectId: string) => {
      closeIfCompact();
      void navigate({ to: "/design/$chatId", params: { chatId: projectId }, search: {} });
    },
    [closeIfCompact, navigate],
  );

  const beginCreateProject = React.useCallback(() => {
    setTitle("Untitled Design");
    setCreateOpen(true);
  }, []);

  const createProject = React.useCallback(async () => {
    const nextTitle = title.trim();
    if (appendReconciliationRequired || createBusy || !nextTitle) return;
    setCreateBusy(true);
    try {
      const project = await designerApi.createProject({
        title: nextTitle,
        connectionState: "prototype-only",
      });
      setCreateOpen(false);
      await refresh();
      openProject(project.id);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Aiden could not create the project.");
    } finally {
      setCreateBusy(false);
    }
  }, [appendReconciliationRequired, createBusy, openProject, refresh, title]);

  const beginRenameProject = React.useCallback(
    (projectId: string) => {
      const project = projects.find(({ id }) => id === projectId);
      if (!project) return;
      setRenameProjectId(project.id);
      setRenameTitle(project.title);
    },
    [projects],
  );

  const renameProject = React.useCallback(async () => {
    if (!renameProjectId || renameBusy) return;
    const project = projects.find(({ id }) => id === renameProjectId);
    const nextTitle = renameTitle.trim();
    if (!project || !nextTitle) return;
    if (nextTitle === project.title) {
      setRenameProjectId(undefined);
      return;
    }
    setRenameBusy(true);
    try {
      const result = await designerApi.renameProject({
        id: project.id,
        expectedRevision: project.revision,
        title: nextTitle,
      });
      if (result.status === "conflict") {
        toast.error("This project changed in another window. The latest version was reloaded.");
      } else {
        setRenameProjectId(undefined);
      }
      onProjectChange(result.status === "updated" ? result.project : result.current);
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The project could not be renamed.");
    } finally {
      setRenameBusy(false);
    }
  }, [onProjectChange, projects, refresh, renameBusy, renameProjectId, renameTitle]);

  const exportProject = React.useCallback(async (projectId: string) => {
    try {
      const project = await designerApi.openProject(projectId);
      if (!project) throw new Error("That Design Project is no longer available.");
      const artboard = project.canvas.nodes.find(
        (node) =>
          node.kind === "artboard" &&
          node.lineageId &&
          node.activeMediaId &&
          node.artifactMediaIds?.includes(node.activeMediaId),
      );
      if (!artboard?.lineageId || !artboard.activeMediaId) {
        throw new Error("Add a generated artboard before exporting this project.");
      }
      const result = await designerApi.exportProjectBundle(
        project.id,
        artboard.lineageId,
        artboard.activeMediaId,
      );
      if (result.status === "saved") {
        toast.success(result.fileName ? `Saved ${result.fileName}` : "Design Project exported.");
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The project could not be exported.");
    }
  }, []);

  const duplicateProject = React.useCallback(
    async (projectId: string) => {
      const project = projects.find(({ id }) => id === projectId);
      if (!project || duplicateBusyId) return;
      setDuplicateBusyId(project.id);
      try {
        const duplicate = await designerApi.duplicateProject({
          id: project.id,
          expectedRevision: project.revision,
        });
        await refresh();
        toast.success(`Created “${duplicate.title}”.`);
      } catch (cause) {
        toast.error(
          cause instanceof Error ? cause.message : "The project could not be duplicated.",
        );
      } finally {
        setDuplicateBusyId(undefined);
      }
    },
    [duplicateBusyId, projects, refresh],
  );

  const previewDeleteProject = React.useCallback(
    async (projectId: string) => {
      const project = projects.find(({ id }) => id === projectId);
      if (!project) return;
      try {
        setDeletePlan(
          await designerApi.previewDeleteProject({
            id: project.id,
            expectedRevision: project.revision,
          }),
        );
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "The delete preview is unavailable.");
      }
    },
    [projects],
  );

  const deleteProject = React.useCallback(async () => {
    if (!deletePlan || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await designerApi.deleteProject({
        id: deletePlan.projectId,
        expectedRevision: deletePlan.expectedRevision,
      });
      const deletedActiveProject = deletePlan.projectId === activeProjectId;
      onProjectUnavailable(deletePlan.projectId);
      setDeletePlan(undefined);
      await refresh();
      if (deletedActiveProject) {
        closeIfCompact();
        await navigate({ to: "/design" });
      }
      toast.success("Design Project deleted.");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The project could not be deleted.");
    } finally {
      setDeleteBusy(false);
    }
  }, [
    activeProjectId,
    closeIfCompact,
    deleteBusy,
    deletePlan,
    navigate,
    onProjectUnavailable,
    refresh,
  ]);

  return (
    <>
      <Sidebar
        header={<WorkspaceModeSwitcher mode={mode} onModeChange={onModeChange} />}
        searchable
        searchPlaceholder="Search projects…"
        searchValue={query}
        onSearchChange={setQuery}
        actions={<SplitView.SidebarToggle />}
        footer={
          <SidebarFooter>
            <div className="flex flex-col gap-0.5">
              <SidebarListItem
                icon={<UserRound />}
                title="Profile"
                selected={pathname === "/profile"}
                onClick={() => {
                  closeIfCompact();
                  void navigate({ to: "/profile" });
                }}
              />
              <SidebarListItem
                icon={<Settings />}
                title="Settings"
                onClick={() => {
                  closeIfCompact();
                  void navigate({ to: "/settings", search: {} });
                }}
              />
            </div>
          </SidebarFooter>
        }
      >
        <div className="px-2.5 pb-2">
          <SidebarListItem
            icon={<Plus />}
            title="New Project"
            disabled={appendReconciliationRequired}
            onClick={beginCreateProject}
          />
        </div>
        <DesignProjectLibrary
          layout="sidebar"
          projects={projects}
          activeProjectId={activeProjectId}
          query={query}
          filter={filter}
          loading={loading}
          error={error}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onCreateProject={beginCreateProject}
          onOpenProject={openProject}
          onRenameProject={beginRenameProject}
          onDuplicateProject={(id) => void duplicateProject(id)}
          onExportProject={(id) => void exportProject(id)}
          onDeleteProject={(id) => void previewDeleteProject(id)}
          onRepairProject={() => void refresh()}
          onRetry={() => void refresh()}
        />
      </Sidebar>

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Design Project"
        description="Projects start in Aiden's private local storage. Connect a workspace or Git repository later from the project."
        confirmLabel="Create project"
        confirmDisabled={!title.trim() || appendReconciliationRequired}
        busy={createBusy}
        onConfirm={createProject}
      >
        <label className="grid gap-1 text-small-strong">
          Project name
          <input
            autoFocus
            value={title}
            maxLength={160}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
          />
        </label>
      </Dialog>

      <AlertDialog
        open={Boolean(deletePlan)}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeletePlan(undefined);
        }}
        title="Delete Design Project?"
        description={
          deletePlan ? (
            <div className="grid gap-2 text-small text-secondary">
              <p>The project and its owned conversation will be permanently removed.</p>
              <div className="grid gap-1 rounded-control bg-control p-3">
                <span>{deletePlan.artifactMediaIds.length} generated revisions</span>
                <span>{deletePlan.detachedReferenceAssetIds.length} reference links</span>
                <span>{deletePlan.commentIds.length} comments</span>
                <span>{deletePlan.designerActionIds.length} source actions</span>
              </div>
            </div>
          ) : null
        }
        confirmLabel="Delete project"
        confirmVariant="destructive"
        busy={deleteBusy}
        keepOpenOnConfirm
        onConfirm={deleteProject}
      />

      <Dialog
        open={Boolean(renameProjectId)}
        onOpenChange={(open) => {
          if (!open && !renameBusy) setRenameProjectId(undefined);
        }}
        title="Rename Design Project"
        description="This changes the project label. Its canvas, conversation, and revision history stay together."
        confirmLabel="Rename project"
        confirmDisabled={!renameTitle.trim()}
        busy={renameBusy}
        onConfirm={renameProject}
      >
        <label className="grid gap-1 text-small-strong">
          Project name
          <input
            autoFocus
            value={renameTitle}
            maxLength={160}
            onChange={(event) => setRenameTitle(event.currentTarget.value)}
            className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
          />
        </label>
      </Dialog>
    </>
  );
}
