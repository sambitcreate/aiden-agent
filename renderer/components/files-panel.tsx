import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Link2,
  RefreshCw,
  Save,
  Search,
  WrapText,
} from "lucide-react";
import { AlertDialog, Button, EmptyState, Input, Text, toast } from "./ui";
import { workspacesApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { cn } from "../lib/ui-utils";
import {
  useCommandHandler,
  useShortcutBinding,
  useShortcutLabel,
} from "../lib/command-system";
import { ariaKeyShortcut } from "../shared/keybindings";
import type {
  Workspace,
  WorkspaceFileDocument,
  WorkspaceFileEntry,
  WorkspaceFileIndex,
} from "../lib/types";

interface LoadState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface SaveIssue {
  code: "changed_on_disk" | "io_error";
  message: string;
}

interface EditorSession {
  query: string;
  expanded: Set<string>;
  selectedPath: string | null;
  documentState: LoadState<WorkspaceFileDocument>;
  draft: string;
  saveError: SaveIssue | null;
  wrap: boolean;
}

export interface FilesEditorState {
  workspaceId?: string;
  path: string | null;
  dirty: boolean;
  saving: boolean;
}

export interface FilesEditorStateChangeOptions {
  /** Increment the lifecycle revision even when dirty/saving booleans stay the same. */
  touch?: boolean;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function useFileIndex(workspaceId: string | undefined, active: boolean) {
  const [state, setState] = React.useState<LoadState<WorkspaceFileIndex>>({
    data: null,
    error: null,
    loading: false,
  });
  const requestRef = React.useRef(0);
  const refresh = React.useCallback(async () => {
    if (!workspaceId) return;
    const request = ++requestRef.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await workspacesApi.files(workspaceId);
      if (request === requestRef.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (request === requestRef.current) {
        setState((current) => ({
          data: current.data,
          error: errorMessage(error, "Aiden could not index this workspace."),
          loading: false,
        }));
      }
    }
  }, [workspaceId]);

  React.useEffect(() => {
    requestRef.current += 1;
    setState({ data: null, error: null, loading: false });
  }, [workspaceId]);
  React.useEffect(() => {
    if (active && workspaceId) void refresh();
  }, [active, refresh, workspaceId]);
  React.useEffect(() => {
    if (active) return;
    requestRef.current += 1;
    setState((current) => current.loading ? { ...current, loading: false } : current);
  }, [active]);
  return { ...state, refresh };
}

function fileIcon(entry: WorkspaceFileEntry, expanded: boolean) {
  if (entry.kind === "directory") {
    return expanded ? <FolderOpen className="size-3.5" /> : <Folder className="size-3.5" />;
  }
  if (entry.symbolic) return <Link2 className="size-3.5" />;
  return <File className="size-3.5" />;
}

function expandAncestors(path: string, current: Set<string>): Set<string> {
  const next = new Set(current);
  const parts = path.split("/");
  parts.pop();
  let parent = "";
  for (const part of parts) {
    parent = parent ? `${parent}/${part}` : part;
    next.add(parent);
  }
  return next;
}

function FileIndexSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-label="Loading workspace files">
      {[62, 78, 54, 84, 68, 58].map((width, index) => (
        <div key={index} className="flex h-7 items-center gap-2 px-2" style={{ paddingLeft: 8 + (index % 3) * 12 }}>
          <span className="size-3.5 animate-pulse rounded bg-control" />
          <span className="h-2 animate-pulse rounded-pill bg-control" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="space-y-2 p-4" aria-label="Loading file">
      {[88, 66, 94, 58, 74, 82, 52, 90].map((width, index) => (
        <div key={index} className="flex items-center gap-3">
          <span className="h-2 w-5 animate-pulse rounded-pill bg-control" />
          <span className="h-2 animate-pulse rounded-pill bg-control" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

export function FilesPanel({
  workspace,
  active,
  requestedPath,
  requestedPathKey,
  compact,
  interactionBlockedReason,
  onEditorStateChange,
}: {
  workspace: Workspace | undefined;
  active: boolean;
  requestedPath: string | null;
  requestedPathKey: number;
  compact: boolean;
  interactionBlockedReason?: string | null;
  onEditorStateChange?: (
    state: FilesEditorState,
    options?: FilesEditorStateChangeOptions,
  ) => void;
}) {
  const queryClient = useQueryClient();
  const available = Boolean(workspace?.folderPath) && workspace?.permission !== "none";
  const interactionBlocked = Boolean(interactionBlockedReason);
  const index = useFileIndex(workspace?.id, active && available && !interactionBlocked);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null);
  const [pendingPath, setPendingPath] = React.useState<string | null>(null);
  const [reloadConfirmOpen, setReloadConfirmOpen] = React.useState(false);
  const [documentState, setDocumentState] = React.useState<LoadState<WorkspaceFileDocument>>({
    data: null,
    error: null,
    loading: false,
  });
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<SaveIssue | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [wrap, setWrap] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const gutterRef = React.useRef<HTMLPreElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const backButtonRef = React.useRef<HTMLButtonElement>(null);
  const alertReturnFocusRef = React.useRef<HTMLElement | null>(null);
  const fileButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const focusDetailRef = React.useRef(false);
  const focusTreePathRef = React.useRef<string | null>(null);
  const consumedRequestKeyRef = React.useRef(0);
  const loadRequestRef = React.useRef(0);
  const saveRequestRef = React.useRef(0);
  const loadedPathRef = React.useRef<string | null>(null);
  const draftRef = React.useRef("");
  const dirty = Boolean(documentState.data && draft !== documentState.data.content);
  const sessionCacheRef = React.useRef(new Map<string, EditorSession>());
  const sessionWorkspaceIdRef = React.useRef(workspace?.id);
  const [reportedWorkspaceId, setReportedWorkspaceId] = React.useState(workspace?.id);
  const sessionSnapshotRef = React.useRef<EditorSession>({
    query,
    expanded,
    selectedPath,
    documentState,
    draft,
    saveError,
    wrap,
  });
  sessionSnapshotRef.current = {
    query,
    expanded,
    selectedPath,
    documentState,
    draft,
    saveError,
    wrap,
  };
  React.useEffect(() => {
    onEditorStateChange?.({
      workspaceId: reportedWorkspaceId,
      path: selectedPath,
      dirty,
      saving,
    });
  }, [dirty, onEditorStateChange, reportedWorkspaceId, saving, selectedPath]);

  React.useLayoutEffect(() => {
    const nextWorkspaceId = workspace?.id;
    const previousWorkspaceId = sessionWorkspaceIdRef.current;
    if (previousWorkspaceId === nextWorkspaceId) return;
    if (previousWorkspaceId) {
      sessionCacheRef.current.set(previousWorkspaceId, {
        ...sessionSnapshotRef.current,
        expanded: new Set(sessionSnapshotRef.current.expanded),
        documentState: {
          ...sessionSnapshotRef.current.documentState,
          loading: false,
        },
      });
    }
    const restored = nextWorkspaceId
      ? sessionCacheRef.current.get(nextWorkspaceId)
      : undefined;
    const restoredDirty = Boolean(
      restored?.documentState.data &&
      restored.draft !== restored.documentState.data.content,
    );
    sessionWorkspaceIdRef.current = nextWorkspaceId;
    setReportedWorkspaceId(nextWorkspaceId);
    loadRequestRef.current += 1;
    saveRequestRef.current += 1;
    setQuery(restored?.query ?? "");
    setExpanded(new Set(restored?.expanded ?? []));
    setSelectedPath(restored?.selectedPath ?? null);
    setPendingPath(null);
    setDocumentState(
      restoredDirty && restored
        ? restored.documentState
        : { data: null, error: null, loading: false },
    );
    draftRef.current = restoredDirty && restored ? restored.draft : "";
    setDraft(draftRef.current);
    setSaveError(restoredDirty && restored ? restored.saveError : null);
    setSaved(false);
    setSaving(false);
    setWrap(restored?.wrap ?? false);
    loadedPathRef.current = restoredDirty ? restored?.selectedPath ?? null : null;
  }, [workspace?.id]);

  const chooseFile = React.useCallback(
    (path: string) => {
      if (path === selectedPath) return;
      if (interactionBlockedReason) {
        toast.info(interactionBlockedReason);
        return;
      }
      if (saving) {
        toast.info("Wait for the current save to finish before opening another file.");
        return;
      }
      if (dirty) {
        alertReturnFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : textareaRef.current;
        setPendingPath(path);
        return;
      }
      if (compact) focusDetailRef.current = true;
      setSelectedPath(path);
      setExpanded((current) => expandAncestors(path, current));
    },
    [compact, dirty, interactionBlockedReason, saving, selectedPath],
  );

  React.useLayoutEffect(() => {
    if (!compact || !selectedPath || !focusDetailRef.current) return;
    focusDetailRef.current = false;
    backButtonRef.current?.focus();
  }, [compact, selectedPath]);

  React.useLayoutEffect(() => {
    if (!compact || selectedPath || focusTreePathRef.current === null) return;
    const previousPath = focusTreePathRef.current;
    focusTreePathRef.current = null;
    const previousButton = fileButtonRefs.current.get(previousPath);
    if (previousButton) previousButton.focus();
    else searchRef.current?.focus();
  }, [compact, selectedPath]);

  React.useEffect(() => {
    if (!requestedPath || consumedRequestKeyRef.current === requestedPathKey) return;
    consumedRequestKeyRef.current = requestedPathKey;
    chooseFile(requestedPath);
  }, [chooseFile, requestedPath, requestedPathKey]);

  const loadFile = React.useCallback(async () => {
    if (!workspace?.id || !selectedPath || !active || interactionBlocked) return;
    const request = ++loadRequestRef.current;
    setDocumentState({ data: null, error: null, loading: true });
    setSaveError(null);
    setSaved(false);
    try {
      const data = await workspacesApi.readFile(workspace.id, selectedPath);
      if (request !== loadRequestRef.current) return;
      loadedPathRef.current = selectedPath;
      setDocumentState({ data, error: null, loading: false });
      draftRef.current = data.content;
      setDraft(data.content);
    } catch (error) {
      if (request !== loadRequestRef.current) return;
      loadedPathRef.current = selectedPath;
      setDocumentState({
        data: null,
        error: errorMessage(error, "Aiden could not open this file."),
        loading: false,
      });
      draftRef.current = "";
      setDraft("");
    }
  }, [active, interactionBlocked, selectedPath, workspace?.id]);

  React.useEffect(() => {
    if (active) return;
    loadRequestRef.current += 1;
    setDocumentState((current) => current.loading ? { ...current, loading: false } : current);
  }, [active]);

  React.useEffect(() => {
    if (!interactionBlocked) return;
    loadRequestRef.current += 1;
    setDocumentState((current) => current.loading ? { ...current, loading: false } : current);
    if (!dirty) loadedPathRef.current = null;
  }, [dirty, interactionBlocked]);

  React.useEffect(() => {
    if (loadedPathRef.current === selectedPath) return;
    if (!active || interactionBlocked || !selectedPath) return;
    loadRequestRef.current += 1;
    setDocumentState({ data: null, error: null, loading: false });
    draftRef.current = "";
    setDraft("");
    setSaveError(null);
    setSaved(false);
    void loadFile();
  }, [active, interactionBlocked, loadFile, selectedPath]);

  const alertReturnFocus = React.useCallback(() => {
    const preferred = alertReturnFocusRef.current;
    if (preferred?.isConnected && preferred.getClientRects().length > 0) return preferred;
    const fallback = backButtonRef.current
      ?? (selectedPath ? fileButtonRefs.current.get(selectedPath) : undefined)
      ?? searchRef.current
      ?? document.querySelector<HTMLElement>("[data-app-focus-root]");
    return fallback?.isConnected ? fallback : null;
  }, [selectedPath]);

  const saveFile = React.useCallback(async () => {
    if (interactionBlockedReason) {
      toast.info(interactionBlockedReason);
      return;
    }
    if (!workspace?.id || !selectedPath || !documentState.data || !dirty || saving) return;
    const request = ++saveRequestRef.current;
    const submittedDraft = draftRef.current;
    let savedBaseline = documentState.data.content;
    onEditorStateChange?.({
      workspaceId: reportedWorkspaceId,
      path: selectedPath,
      dirty: true,
      saving: true,
    });
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await workspacesApi.writeFile(
        workspace.id,
        selectedPath,
        submittedDraft,
        documentState.data.version,
      );
      if (request !== saveRequestRef.current) return;
      if (!result.ok) {
        setSaveError({ code: result.code, message: result.message });
        return;
      }
      const next = result.document;
      savedBaseline = next.content;
      const newerDraft = draftRef.current !== submittedDraft;
      setDocumentState({ data: next, error: null, loading: false });
      if (!newerDraft) {
        draftRef.current = next.content;
        setDraft(next.content);
      }
      setSaved(!newerDraft);
      toast.success(`Saved ${selectedPath}`);
      if (next.warning) toast.warning(next.warning);
      if (!newerDraft) window.setTimeout(() => setSaved(false), 1_600);
      void Promise.all([
        index.refresh(),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitReview(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.git(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.gitBranches(workspace.id) }),
      ]);
    } catch (error) {
      if (request !== saveRequestRef.current) return;
      setSaveError({
        code: "io_error",
        message: errorMessage(error, "Aiden could not save this file."),
      });
    } finally {
      if (request === saveRequestRef.current) {
        setSaving(false);
        onEditorStateChange?.({
          workspaceId: reportedWorkspaceId,
          path: selectedPath,
          dirty: draftRef.current !== savedBaseline,
          saving: false,
        });
      }
    }
  }, [dirty, documentState.data, index, interactionBlockedReason, onEditorStateChange, queryClient, reportedWorkspaceId, saving, selectedPath, workspace?.id]);

  useCommandHandler(
    "file.save",
    saveFile,
    Boolean(selectedPath && documentState.data && !saving && !interactionBlockedReason),
  );
  const saveShortcut = useShortcutLabel("file.save");
  const saveShortcutBinding = useShortcutBinding("file.save");

  const lineNumbers = React.useMemo(() => {
    const count = Math.max(1, draft.split("\n").length);
    return Array.from({ length: count }, (_, index) => index + 1).join("\n");
  }, [draft]);

  const allEntries = index.data?.entries ?? [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = React.useMemo(() => {
    if (normalizedQuery) {
      return allEntries.filter(
        (entry) =>
          entry.kind === "file" && entry.path.toLocaleLowerCase().includes(normalizedQuery),
      );
    }
    return allEntries.filter((entry) => {
      if (!entry.parentPath) return true;
      const ancestors = entry.parentPath.split("/");
      let current = "";
      for (const ancestor of ancestors) {
        current = current ? `${current}/${ancestor}` : ancestor;
        if (!expanded.has(current)) return false;
      }
      return true;
    });
  }, [allEntries, expanded, normalizedQuery]);

  const selectEntry = React.useCallback(
    (entry: WorkspaceFileEntry) => {
      if (interactionBlockedReason) {
        toast.info(interactionBlockedReason);
        return;
      }
      if (entry.kind === "directory") {
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        return;
      }
      if (entry.kind === "file") chooseFile(entry.path);
    },
    [chooseFile, interactionBlockedReason],
  );

  if (!workspace?.folderPath) {
    return (
      <EmptyState
        className="h-full"
        title="No workspace folder"
        description="Choose a local workspace to browse and edit files beside the conversation."
      />
    );
  }
  if (workspace.permission === "none") {
    return (
      <EmptyState
        className="h-full"
        title="File access is off"
        description="Change this workspace from No Access before opening Review or Files."
      />
    );
  }

  const showTree = !compact || !selectedPath;
  const showEditor = !compact || Boolean(selectedPath);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 overflow-hidden">
      <section
        aria-label="Workspace files"
        className={cn(
          "flex min-h-0 w-[190px] shrink-0 flex-col border-r border-separator bg-sidebar",
          compact && "w-full border-r-0",
          !showTree && "hidden",
        )}
      >
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-separator px-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search workspace files"
              placeholder="Search files"
              className="h-7 border-transparent bg-input pl-8 pr-2 text-small shadow-none"
            />
          </div>
          <Button
            variant="transparent"
            size="small"
            iconOnly
            onClick={() => void index.refresh()}
            disabled={index.loading || interactionBlocked}
            aria-label="Refresh files"
            title="Refresh files"
          >
            <RefreshCw className={cn(index.loading && "animate-spin")} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {index.loading && !index.data ? (
            <FileIndexSkeleton />
          ) : index.error && !index.data ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <AlertCircle className="size-5 text-red" />
              <Text variant="small" color="secondary" as="p">{index.error}</Text>
              <Button size="small" onClick={() => void index.refresh()}>Try again</Button>
            </div>
          ) : allEntries.length === 0 ? (
            <EmptyState
              className="h-full px-3"
              title="Empty workspace"
              description="Files created in this folder will appear here after a refresh."
            />
          ) : visibleEntries.length === 0 ? (
            <EmptyState
              className="h-full px-3"
              title="No matching files"
              description="Try a shorter name or path."
            />
          ) : (
            visibleEntries.map((entry) => {
              const isExpanded = expanded.has(entry.path);
              const selected = selectedPath === entry.path;
              return (
                <button
                  key={entry.path}
                  ref={(element) => {
                    if (element) fileButtonRefs.current.set(entry.path, element);
                    else fileButtonRefs.current.delete(entry.path);
                  }}
                  type="button"
                  onClick={() => selectEntry(entry)}
                  disabled={entry.kind === "symlink" || interactionBlocked}
                  aria-expanded={entry.kind === "directory" ? isExpanded : undefined}
                  aria-current={selected ? "true" : undefined}
                  title={interactionBlockedReason ?? entry.path}
                  className={cn(
                    "flex h-7 w-full items-center gap-1 rounded-lg pr-1.5 text-left text-small outline-none transition-colors duration-150 focus-visible:bg-list-selection focus-visible:outline-none disabled:opacity-45",
                    selected ? "bg-list-selection text-primary" : "text-secondary hover:bg-list-hover hover:text-primary active:bg-list-selection",
                  )}
                  style={{ paddingLeft: 4 + (normalizedQuery ? 0 : entry.depth * 12) }}
                >
                  <span className="grid size-4 shrink-0 place-items-center text-tertiary">
                    {entry.kind === "directory" ? (
                      isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />
                    ) : null}
                  </span>
                  <span className="shrink-0 text-tertiary">{fileIcon(entry, isExpanded)}</span>
                  <span className="min-w-0 flex-1 truncate">{normalizedQuery ? entry.path : entry.name}</span>
                </button>
              );
            })
          )}
        </div>
        {index.data?.truncated || index.error ? (
          <div className="shrink-0 border-t border-separator px-2.5 py-2 text-mini text-tertiary">
            {index.error
              ? index.data?.truncated
                ? "Refresh failed. Showing the last index, limited to 4,000 entries."
                : "Refresh failed. Showing the last file index."
              : "Large workspace: showing the first 4,000 entries. Search is limited to this index."}
          </div>
        ) : null}
      </section>

      <section
        aria-label="File editor"
        className={cn("min-w-0 flex-1 bg-background", !showEditor && "hidden")}
      >
        {!selectedPath ? (
          <EmptyState
            className="h-full"
            title="Choose a file"
            description="Select a UTF-8 text file to open the full editor. Saves are version-checked against the file on disk."
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-separator px-2">
              {compact ? (
                <Button
                  ref={backButtonRef}
                  variant="transparent"
                  size="small"
                  iconOnly
                  disabled={saving || interactionBlocked}
                  onClick={(event) => {
                    if (dirty) {
                      alertReturnFocusRef.current = event.currentTarget;
                      setPendingPath("");
                    }
                    else {
                      focusTreePathRef.current = selectedPath;
                      setSelectedPath(null);
                    }
                  }}
                  aria-label="Back to files"
                >
                  <ChevronLeft />
                </Button>
              ) : null}
              <FileCode2 className="size-3.5 shrink-0 text-tertiary" />
              <Text variant="small-strong" truncate className="min-w-0 flex-1" title={selectedPath}>
                {selectedPath}
              </Text>
              <Text
                variant="small"
                color={saveError ? "red" : dirty ? "secondary" : "tertiary"}
                className="shrink-0"
                role="status"
              >
                {saving ? "Saving…" : interactionBlocked ? "Git operation…" : saveError ? "Save failed" : dirty ? "Edited" : saved ? "Saved" : ""}
              </Text>
              <Button
                variant="transparent"
                size="small"
                iconOnly
                onClick={() => setWrap((value) => !value)}
                aria-label={wrap ? "Turn off line wrapping" : "Wrap long lines"}
                aria-pressed={wrap}
                title={wrap ? "Turn off line wrapping" : "Wrap long lines"}
              >
                <WrapText />
              </Button>
              <Button
                variant="filled"
                size="small"
                onClick={() => void saveFile()}
                aria-keyshortcuts={ariaKeyShortcut(saveShortcutBinding)}
                disabled={!dirty || saving || !documentState.data || interactionBlocked}
                title={interactionBlockedReason ?? `Save file (${saveShortcut})`}
              >
                <Save /> Save
              </Button>
            </div>

            {saveError ? (
              <div className="flex shrink-0 items-start gap-2 border-b border-support-red/25 bg-support-red/[0.06] px-3 py-2">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-red" />
                <Text variant="small" color="red" as="p" className="min-w-0 flex-1 select-text">
                  {saveError.message}
                </Text>
                <Button
                  variant="transparent"
                  size="small"
                  disabled={interactionBlocked}
                  onClick={(event) => {
                    if (saveError.code === "changed_on_disk") {
                      alertReturnFocusRef.current = event.currentTarget;
                      setReloadConfirmOpen(true);
                    }
                    else void saveFile();
                  }}
                >
                  {saveError.code === "changed_on_disk" ? "Reload" : "Retry"}
                </Button>
              </div>
            ) : null}

            <div className="min-h-0 flex-1">
              {documentState.loading ? (
                <EditorSkeleton />
              ) : documentState.error ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <AlertCircle className="size-5 text-tertiary" />
                  <div>
                    <Text variant="strong" as="p">File unavailable</Text>
                    <Text variant="small" color="secondary" as="p" className="mt-1 max-w-sm select-text">
                      {documentState.error}
                    </Text>
                  </div>
                  <Button size="small" disabled={interactionBlocked} onClick={() => void loadFile()}>Try again</Button>
                </div>
              ) : documentState.data ? (
                <div className={cn(
                  "code-font-sized grid h-full min-h-0 overflow-hidden bg-background font-mono leading-5",
                  wrap ? "grid-cols-1" : "grid-cols-[auto_minmax(0,1fr)]",
                )}>
                  <pre
                    ref={gutterRef}
                    aria-hidden="true"
                    className={cn(
                      "m-0 min-w-10 overflow-hidden border-r border-separator bg-well px-2 py-3 text-right tabular-nums text-tertiary select-none",
                      wrap && "hidden",
                    )}
                  >
                    {lineNumbers}
                  </pre>
                  <textarea
                    data-command-scope="fileEditor"
                    ref={textareaRef}
                    value={draft}
                    onChange={(event) => {
                      if (interactionBlocked) return;
                      const nextDraft = event.target.value;
                      draftRef.current = nextDraft;
                      onEditorStateChange?.({
                        workspaceId: reportedWorkspaceId,
                        path: selectedPath,
                        dirty: Boolean(documentState.data && nextDraft !== documentState.data.content),
                        saving,
                      }, { touch: true });
                      setDraft(nextDraft);
                      setSaveError((current) => current?.code === "changed_on_disk" ? current : null);
                      setSaved(false);
                    }}
                    onScroll={(event) => {
                      if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                    }}
                    aria-label={`Edit ${selectedPath}`}
                    aria-readonly={saving || interactionBlocked}
                    readOnly={saving || interactionBlocked}
                    wrap={wrap ? "soft" : "off"}
                    spellCheck={false}
                    className="h-full min-h-0 w-full resize-none overflow-auto border-0 bg-transparent p-3 text-primary outline-none select-text"
                  />
                </div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <AlertDialog
        open={pendingPath !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPath(null);
        }}
        title="Discard unsaved edits?"
        description="This file has changes that have not been saved. Discard them before opening another file?"
        confirmLabel="Discard edits"
        confirmVariant="destructive"
        returnFocus={alertReturnFocus}
        onConfirm={() => {
          const nextPath = pendingPath;
          loadRequestRef.current += 1;
          saveRequestRef.current += 1;
          loadedPathRef.current = null;
          draftRef.current = "";
          setPendingPath(null);
          setDocumentState({ data: null, error: null, loading: false });
          setDraft("");
          setSaveError(null);
          setSaved(false);
          onEditorStateChange?.({
            workspaceId: reportedWorkspaceId,
            path: nextPath || null,
            dirty: false,
            saving: false,
          }, { touch: true });
          if (nextPath) {
            if (compact) focusDetailRef.current = true;
            setSelectedPath(nextPath);
            setExpanded((current) => expandAncestors(nextPath, current));
          } else {
            focusTreePathRef.current = selectedPath;
            setSelectedPath(null);
          }
        }}
      />
      <AlertDialog
        open={reloadConfirmOpen}
        onOpenChange={setReloadConfirmOpen}
        title="Reload from disk?"
        description="Reloading replaces the unsaved editor contents with the current file on disk."
        confirmLabel="Reload file"
        confirmVariant="destructive"
        returnFocus={alertReturnFocus}
        onConfirm={() => {
          setReloadConfirmOpen(false);
          void loadFile();
        }}
      />
    </div>
  );
}
