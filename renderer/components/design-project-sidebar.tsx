import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Plus, Settings, UserRound } from "lucide-react";
import { designerApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import type { ShellMode } from "../lib/shell-mode";
import type {
  DesignArtifactRecoveryPlanV1,
  DesignProjectDeletePlanV1,
  DesignProjectFilter,
  DesignProjectRecordSummaryV1,
  DesignProjectSnapshot as DesignProjectSnapshotV1,
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
  onModeChange: (mode: ShellMode) => boolean;
  onProjectChange: (project: DesignProjectSnapshotV1) => void;
  onProjectUnavailable: (projectId: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { closeIfCompact } = useSplitViewSidebar();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const appendReconciliationRequired = useAppendReconciliationRequired();
  const [projects, setProjects] = React.useState<DesignProjectRecordSummaryV1[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<DesignProjectFilter>("all");
  const [createBusy, setCreateBusy] = React.useState(false);
  const createInFlightRef = React.useRef(false);
  const [renameProjectId, setRenameProjectId] = React.useState<string>();
  const [renameTitle, setRenameTitle] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);
  const [duplicateBusyId, setDuplicateBusyId] = React.useState<string>();
  const [deletePlan, setDeletePlan] = React.useState<DesignProjectDeletePlanV1>();
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [recoveryPlan, setRecoveryPlan] = React.useState<DesignArtifactRecoveryPlanV1>();
  const [recoveryBusyId, setRecoveryBusyId] = React.useState<string>();

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await designerApi.listProjects());
      setError(undefined);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Design Projects are unavailable.");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!projectUpdate) return;
    let cancelled = false;
    const artboards = projectUpdate.canvas.nodes.filter(({ kind }) => kind === "artboard");
    const summaryBase = {
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
    };
    setProjects((current) => {
      const prior = current.find(({ id }) => id === projectUpdate.id);
      const summary: DesignProjectRecordSummaryV1 = {
        ...summaryBase,
        health: prior?.health ?? "ready",
        ...(prior?.recoveryMessage ? { recoveryMessage: prior.recoveryMessage } : {}),
        ...(prior?.recoveryAction ? { recoveryAction: prior.recoveryAction } : {}),
      };
      return [summary, ...current.filter(({ id }) => id !== summary.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
    });
    // A project snapshot intentionally omits health because health requires
    // semantic reads from main-owned artifact/reference stores. Refresh that
    // projection after every content revision so a successful repair clears
    // stale recovery chrome without a remount.
    void designerApi
      .listProjects()
      .then((latest) => {
        if (!cancelled) setProjects(latest);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Design Projects are unavailable.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectUpdate]);

  const openProject = React.useCallback(
    (projectId: string) => {
      closeIfCompact();
      void navigate({ to: "/design/$chatId", params: { chatId: projectId }, search: {} });
    },
    [closeIfCompact, navigate],
  );

  const createProject = React.useCallback(async () => {
    if (appendReconciliationRequired || createInFlightRef.current) return;
    createInFlightRef.current = true;
    setCreateBusy(true);
    try {
      const project = await designerApi.createProject();
      await refresh();
      openProject(project.id);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Aiden could not create the project.");
    } finally {
      createInFlightRef.current = false;
      setCreateBusy(false);
    }
  }, [appendReconciliationRequired, openProject, refresh]);

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
      const openResult = await designerApi.openProject(projectId);
      if (!openResult) throw new Error("That Design Project is no longer available.");
      const project = openResult.project;
      if (openResult.designPublication === "retryable") {
        toast.info(
          "Design history is still being reconciled. Reopen this project to retry recovery.",
        );
      }
      const artboard = project.canvas.nodes.find(
        (node) =>
          node.kind === "artboard" &&
          node.lineageId &&
          node.activeMediaId &&
          node.artifactMediaIds?.includes(node.activeMediaId),
      );
      if (!artboard?.lineageId || !artboard.activeMediaId) {
        throw new Error("Add a generated Screen before exporting this project.");
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

  const inspectRecovery = React.useCallback(
    async (projectId: string) => {
      if (recoveryBusyId) return;
      setRecoveryBusyId(projectId);
      try {
        setRecoveryPlan(await designerApi.inspectArtifactRecovery(projectId));
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Recovery could not be inspected.");
      } finally {
        setRecoveryBusyId(undefined);
      }
    },
    [recoveryBusyId],
  );

  const confirmRecovery = React.useCallback(async () => {
    if (!recoveryPlan || recoveryBusyId) return;
    if (recoveryPlan.status === "regenerate") {
      setRecoveryPlan(undefined);
      openProject(recoveryPlan.projectId);
      return;
    }
    setRecoveryBusyId(recoveryPlan.projectId);
    try {
      const result = await designerApi.recoverArtifact({
        projectId: recoveryPlan.projectId,
        expectedRevision: recoveryPlan.expectedRevision,
      });
      if (result.status === "regenerate") {
        if (result.project) {
          onProjectChange(result.project);
          setRecoveryPlan(undefined);
          if (!(await refresh())) {
            toast.error(
              "The repair finished, but the project list could not be refreshed. Retry the project list before regenerating.",
            );
            return;
          }
        }
        setRecoveryPlan(result.plan);
        return;
      }
      const project = result.status === "recovered" ? result.project : result.current;
      onProjectChange(project);
      setRecoveryPlan(undefined);
      if (result.status === "recovered") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.chat(project.chatId) });
      }
      await refresh();
      if (result.status === "recovered") {
        toast.success(
          result.operation === "remove-missing-history"
            ? "Unavailable Design history entry removed."
            : "Recovered as a new Design revision.",
        );
      } else {
        toast.error("This project changed. Review the latest version and try again.");
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The revision could not be recovered.");
    } finally {
      setRecoveryBusyId(undefined);
    }
  }, [onProjectChange, openProject, queryClient, recoveryBusyId, recoveryPlan, refresh]);

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
            title={createBusy ? "Creating…" : "New Project"}
            disabled={appendReconciliationRequired || createBusy}
            onClick={() => void createProject()}
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
          createBusy={createBusy}
          createDisabled={appendReconciliationRequired}
          onCreateProject={() => void createProject()}
          onOpenProject={openProject}
          onRenameProject={beginRenameProject}
          onDuplicateProject={(id) => void duplicateProject(id)}
          onExportProject={(id) => void exportProject(id)}
          onDeleteProject={(id) => void previewDeleteProject(id)}
          onRepairProject={(id) => {
            const project = projects.find(({ id: projectId }) => projectId === id);
            if (project?.recoveryAction === "open-project") {
              openProject(id);
              return;
            }
            void inspectRecovery(id);
          }}
          onRetry={() => void refresh()}
        />
      </Sidebar>

      <AlertDialog
        open={Boolean(recoveryPlan)}
        onOpenChange={(open) => {
          if (!open && !recoveryBusyId) setRecoveryPlan(undefined);
        }}
        title={
          recoveryPlan?.operation === "remove-missing-history"
            ? "Remove unavailable history entry?"
            : recoveryPlan?.operation === "remove-missing-artboard"
              ? "Remove broken Screen?"
              : recoveryPlan?.status === "recoverable"
                ? "Recover Design revision?"
                : "Regenerate this Screen"
        }
        description={recoveryPlan?.message}
        confirmLabel={
          recoveryPlan?.operation === "remove-missing-history"
            ? "Remove missing history entry"
            : recoveryPlan?.operation === "remove-missing-artboard"
              ? "Remove broken Screen"
              : recoveryPlan?.status === "recoverable"
                ? "Recover as new revision"
                : "Open to regenerate"
        }
        busy={Boolean(recoveryBusyId)}
        keepOpenOnConfirm
        onConfirm={confirmRecovery}
      />

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
