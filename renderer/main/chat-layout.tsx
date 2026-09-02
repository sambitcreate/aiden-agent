// Persistent chat shell: workspace switcher + history sidebar + active chat.
// Selection is route-driven (chatId param); the unified sidebar can open chats
// across registered workspaces while WorkspaceProvider tracks execution context.

import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import {
  AlertDialog,
  Button,
  Dialog,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SplitView,
  Text,
  toast,
} from "../components/ui";
import { ChatSidebar } from "../components/chat-sidebar";
import { chatsApi, designerApi, onNotification } from "../lib/ipc";
import {
  CHAT_TITLE_FADE_OUT_MS,
  CHAT_TITLE_REVEAL_DURATION_MS,
  type ChatTitleRevealEvent,
} from "../lib/chat-title-reveal";
import { queryKeys, useChats } from "../lib/queries";
import { useActiveWorkspace } from "../lib/workspace-context";
import { TerminalDrawer } from "../components/terminal-drawer";
import { EnvironmentWorkbench, useEnvironmentPanel } from "../components/environment-panel";
import type { Chat, ChatMetadataUpdated, ChatMeta } from "../lib/types";
import { useAppendReconciliationRequired } from "../lib/append-reconciliation";
import { DesignProjectLibrary } from "../components/design-project-library";
import type {
  DesignProjectConnectionState,
  DesignProjectDeletePlanV1,
  DesignProjectFilter,
  DesignProjectRecordSummaryV1,
  DesignProjectSnapshotV1,
} from "../shared/design-projects";
import { ChatPane } from "./chat-pane";

export function ChatLayout() {
  const params = useParams({ strict: false }) as { chatId?: string };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const environmentPanel = useEnvironmentPanel();
  const [titleReveal, setTitleReveal] = React.useState<ChatTitleRevealEvent | null>(null);

  React.useLayoutEffect(() => {
    if (pathname.startsWith("/design") && environmentPanel.open) environmentPanel.close();
  }, [environmentPanel.close, environmentPanel.open, pathname]);

  React.useEffect(() => {
    let clearReveal: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onNotification<ChatMetadataUpdated>("chats:metadata-updated", (update) => {
      const previousTitle =
        qc.getQueryData<Chat | null>(queryKeys.chat(update.chatId))?.title ??
        qc
          .getQueriesData<ChatMeta[]>({ queryKey: queryKeys.chats })
          .flatMap(([, chats]) => chats ?? [])
          .find((chat) => chat.id === update.chatId)?.title ??
        update.title;
      qc.setQueryData<Chat | null>(queryKeys.chat(update.chatId), (current) =>
        current ? { ...current, title: update.title, updatedAt: update.updatedAt } : current,
      );
      qc.setQueriesData<ChatMeta[]>({ queryKey: queryKeys.chats }, (current) => {
        if (!current) return current;
        return current
          .map((chat) =>
            chat.id === update.chatId
              ? { ...chat, title: update.title, updatedAt: update.updatedAt }
              : chat,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt);
      });
      const reveal = { chatId: update.chatId, version: update.updatedAt, previousTitle };
      setTitleReveal(reveal);
      clearTimeout(clearReveal);
      clearReveal = setTimeout(
        () => {
          setTitleReveal((current) => (current?.version === reveal.version ? null : current));
        },
        CHAT_TITLE_FADE_OUT_MS + CHAT_TITLE_REVEAL_DURATION_MS + 50,
      );
    });

    return () => {
      unsubscribe();
      clearTimeout(clearReveal);
    };
  }, [qc]);

  return (
    <SplitView
      storageKey="aiden-agent"
      sidebar={
        <ChatSidebar
          activeChatId={pathname.startsWith("/design") ? undefined : params.chatId}
          designChatId={params.chatId}
          titleReveal={titleReveal}
        />
      }
      sidebarSize={{ default: 272, min: 236, max: 340 }}
      contentModalOpen={environmentPanel.compactModalOpen}
    >
      <EnvironmentWorkbench>
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </div>
          {pathname === "/profile" ||
          pathname === "/scheduled" ||
          pathname.startsWith("/design") ||
          (pathname.startsWith("/bots") && !params.chatId) ? null : (
            <TerminalDrawer />
          )}
        </div>
      </EnvironmentWorkbench>
    </SplitView>
  );
}

/**
 * Index route: send the user to the most recent chat in the active workspace,
 * or create a fresh one so the composer always operates on a concrete chatId.
 */
export function ChatIndex() {
  const navigate = useNavigate();
  const { activeId, isLoading } = useActiveWorkspace();
  const chats = useChats(activeId);
  const startedRef = React.useRef(false);
  const appendReconciliationRequired = useAppendReconciliationRequired();

  React.useEffect(() => {
    if (
      appendReconciliationRequired ||
      isLoading ||
      !activeId ||
      chats.isLoading ||
      startedRef.current
    ) {
      return;
    }
    startedRef.current = true;
    const list = chats.data ?? [];
    if (list.length > 0) {
      void navigate({ to: "/chat/$chatId", params: { chatId: list[0].id }, replace: true });
    } else {
      void chatsApi
        .create({ workspaceId: activeId })
        .then((chat) => {
          void chats.refetch();
          void navigate({ to: "/chat/$chatId", params: { chatId: chat.id }, replace: true });
        })
        .catch((error: unknown) => {
          startedRef.current = false;
          toast.error(error instanceof Error ? error.message : "Aiden could not create a chat.");
        });
    }
  }, [
    appendReconciliationRequired,
    isLoading,
    activeId,
    chats.isLoading,
    chats.data,
    navigate,
    chats,
  ]);

  return appendReconciliationRequired ? (
    <div className="flex h-full items-center justify-center p-6" role="status">
      <Text color="secondary">
        Reload Aiden to reconcile the previous message before continuing.
      </Text>
    </div>
  ) : (
    <div className="h-full" />
  );
}

export function DesignIndex() {
  const navigate = useNavigate();
  const { activeId, isLoading, workspaces } = useActiveWorkspace();
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
  const [connection, setConnection] =
    React.useState<DesignProjectConnectionState>("prototype-only");
  const [connectedWorkspaceId, setConnectedWorkspaceId] = React.useState("");
  const connectedWorkspaces = React.useMemo(
    () =>
      workspaces.filter(
        (workspace) =>
          Boolean(workspace.folderPath) &&
          workspace.permission !== "none" &&
          !workspace.managedWorktree,
      ),
    [workspaces],
  );

  React.useEffect(() => {
    if (!createOpen || connection !== "connected") return;
    setConnectedWorkspaceId((current) => {
      if (connectedWorkspaces.some(({ id }) => id === current)) return current;
      if (connectedWorkspaces.some(({ id }) => id === activeId)) return activeId ?? "";
      return connectedWorkspaces[0]?.id ?? "";
    });
  }, [activeId, connectedWorkspaces, connection, createOpen]);

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

  const openProject = React.useCallback(
    (projectId: string) => {
      void navigate({ to: "/design/$chatId", params: { chatId: projectId }, search: {} });
    },
    [navigate],
  );

  const createProject = React.useCallback(async () => {
    if (
      appendReconciliationRequired ||
      createBusy ||
      (connection === "connected" && !connectedWorkspaceId)
    ) {
      return;
    }
    setCreateBusy(true);
    try {
      const project = await designerApi.createProject({
        title,
        connectionState: connection,
        ...(connection === "connected" ? { workspaceId: connectedWorkspaceId } : {}),
      });
      setCreateOpen(false);
      openProject(project.id);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Aiden could not create the project.");
    } finally {
      setCreateBusy(false);
    }
  }, [appendReconciliationRequired, connectedWorkspaceId, connection, createBusy, openProject, title]);

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
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The project could not be renamed.");
    } finally {
      setRenameBusy(false);
    }
  }, [projects, refresh, renameBusy, renameProjectId, renameTitle]);

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
        toast.error(cause instanceof Error ? cause.message : "The project could not be duplicated.");
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
      setDeletePlan(undefined);
      await refresh();
      toast.success("Design Project deleted.");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The project could not be deleted.");
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteBusy, deletePlan, refresh]);

  const summaries = projects;

  return (
    <div className="flex h-full min-h-0 bg-well">
      <DesignProjectLibrary
        projects={summaries}
        query={query}
        filter={filter}
        loading={loading || isLoading}
        error={error}
        onQueryChange={setQuery}
        onFilterChange={setFilter}
        onCreateProject={() => setCreateOpen(true)}
        onOpenProject={openProject}
        onRenameProject={beginRenameProject}
        onDuplicateProject={(id) => void duplicateProject(id)}
        onExportProject={(id) => void exportProject(id)}
        onDeleteProject={(id) => void previewDeleteProject(id)}
        onRepairProject={() => void refresh()}
        onRetry={() => void refresh()}
      />
      <main className="grid min-w-0 flex-1 place-items-center p-8">
        <div className="max-w-lg text-center">
          <Text as="h1" variant="heading1">
            Design Projects
          </Text>
          <Text as="p" color="secondary" className="mt-2">
            Each project keeps its canvas and references locally. Inspect source or export an
            explicit copy when you are ready to move from exploration to engineering.
          </Text>
          <Button className="mt-5" variant="accent" onClick={() => setCreateOpen(true)}>
            New project
          </Button>
        </div>
      </main>
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Design Project"
        description="Start in Aiden's local project storage, or explicitly connect a folder-backed app."
        confirmLabel="Create project"
        confirmDisabled={
          !title.trim() ||
          appendReconciliationRequired ||
          (connection === "connected" && !connectedWorkspaceId)
        }
        busy={createBusy}
        onConfirm={createProject}
      >
        <label className="grid gap-1 text-small-strong">
          Project name
          <input
            value={title}
            maxLength={160}
            onChange={(event) => setTitle(event.currentTarget.value)}
            className="h-9 rounded-control border border-separator bg-input px-3 text-regular text-primary outline-none focus:bg-control"
          />
        </label>
        <fieldset className="mt-4 grid gap-2">
          <legend className="mb-1 text-small-strong">Starting point</legend>
          {(
            [
              [
                "prototype-only",
                "Prototype an idea",
                "Self-contained HTML, CSS, and JavaScript stay in Aiden's private local project storage. Export or connect later.",
              ],
              [
                "connected",
                "Connect a local app",
                "Choose a folder workspace. Source changes still require exact review.",
              ],
            ] as const
          ).map(([value, label, description]) => (
            <label key={value} className="flex gap-3 rounded-control bg-control p-3 text-left">
              <input
                type="radio"
                name="design-project-origin"
                value={value}
                checked={connection === value}
                onChange={() => setConnection(value)}
              />
              <span className="grid gap-0.5">
                <strong className="text-small-strong">{label}</strong>
                <span className="text-small text-secondary">{description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {connection === "connected" ? (
          <div className="mt-4 grid gap-1.5">
            <label className="text-small-strong" htmlFor="design-connected-workspace">
              App workspace
            </label>
            {connectedWorkspaces.length > 0 ? (
              <Select value={connectedWorkspaceId} onValueChange={setConnectedWorkspaceId}>
                <SelectTrigger id="design-connected-workspace" aria-label="App workspace">
                  <SelectValue placeholder="Choose a folder workspace" />
                </SelectTrigger>
                <SelectContent>
                  {connectedWorkspaces.map((workspace) => (
                    <SelectItem key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Text as="p" variant="small" color="secondary" role="status">
                Add a folder workspace with file access before connecting an app.
              </Text>
            )}
          </div>
        ) : null}
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
    </div>
  );
}

export function DesignProjectRoute({
  projectOrLegacyChatId,
  initialMediaId,
}: {
  projectOrLegacyChatId: string;
  initialMediaId?: string;
}) {
  const navigate = useNavigate();
  const [project, setProject] = React.useState<DesignProjectSnapshotV1>();
  const [error, setError] = React.useState<string>();

  React.useEffect(() => {
    let cancelled = false;
    setProject(undefined);
    setError(undefined);
    void designerApi
      .openProject(projectOrLegacyChatId)
      .then((opened) => {
        if (cancelled) return;
        if (!opened) {
          setError("That Design Project is no longer available.");
          return;
        }
        setProject(opened);
        if (opened.id !== projectOrLegacyChatId) {
          void navigate({
            to: "/design/$chatId",
            params: { chatId: opened.id },
            search: initialMediaId ? { artifact: initialMediaId } : {},
            replace: true,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Aiden could not open this project.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialMediaId, navigate, projectOrLegacyChatId]);

  if (error) {
    return (
      <div className="grid h-full place-items-center p-6">
        <Text color="secondary">{error}</Text>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="grid h-full place-items-center p-6" role="status">
        <Text color="secondary">Opening Design Project…</Text>
      </div>
    );
  }
  return (
    <ChatPane
      chatId={project.chatId}
      presentation="design"
      initialDesignMediaId={initialMediaId}
      designProject={project}
    />
  );
}
