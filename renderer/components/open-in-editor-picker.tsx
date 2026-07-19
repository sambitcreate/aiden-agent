import * as React from "react";
import { AppWindow, ChevronDown, Folder } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "./ui";
import {
  persistPreferredEditorId,
  readPreferredEditorId,
  resolvePreferredEditorId,
} from "../lib/editor-preference";
import { onNotification, workspacesApi } from "../lib/ipc";
import type { ExternalEditor } from "../lib/types";

interface OpenInEditorPickerProps {
  workspaceId?: string;
  folderPath?: string;
}

function EditorIcon({ editor, className }: { editor: ExternalEditor; className: string }) {
  if (editor.iconDataUrl) {
    return (
      <img
        src={editor.iconDataUrl}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={className}
      />
    );
  }
  const Icon = editor.id === "finder" ? Folder : AppWindow;
  return <Icon aria-hidden="true" className={className} />;
}

export function OpenInEditorPicker({ workspaceId, folderPath }: OpenInEditorPickerProps) {
  const [editors, setEditors] = React.useState<ExternalEditor[]>([]);
  const [storedEditorId, setStoredEditorId] = React.useState<string | null>(readPreferredEditorId);
  const [isLoading, setIsLoading] = React.useState(true);
  const mountedRef = React.useRef(false);

  const refreshEditors = React.useCallback(
    async (forceRefresh: boolean): Promise<ExternalEditor[] | null> => {
      if (mountedRef.current) setIsLoading(true);
      try {
        const discovered = await workspacesApi.externalEditors(forceRefresh);
        if (mountedRef.current) setEditors(discovered);
        return discovered;
      } catch (error) {
        if (mountedRef.current) {
          toast.error(error instanceof Error ? error.message : "Couldn't find installed editors.");
        }
        return null;
      } finally {
        if (mountedRef.current) setIsLoading(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    mountedRef.current = true;
    void refreshEditors(false);
    return () => {
      mountedRef.current = false;
    };
  }, [refreshEditors]);

  const preferredEditorId = React.useMemo(
    () => resolvePreferredEditorId(editors, storedEditorId),
    [editors, storedEditorId],
  );
  const preferredEditor = editors.find((editor) => editor.id === preferredEditorId);

  const rememberEditor = React.useCallback((editorId: string) => {
    setStoredEditorId(editorId);
    persistPreferredEditorId(editorId);
  }, []);

  React.useEffect(() => {
    if (preferredEditorId && preferredEditorId !== storedEditorId)
      rememberEditor(preferredEditorId);
  }, [preferredEditorId, rememberEditor, storedEditorId]);

  const openInEditor = React.useCallback(
    async (editor: ExternalEditor) => {
      if (!workspaceId || !folderPath) return;
      rememberEditor(editor.id);
      try {
        await workspacesApi.openInEditor(workspaceId, editor.id);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : `Couldn't open this workspace in ${editor.label}.`,
        );
        const refreshed = await refreshEditors(true);
        if (!refreshed) return;
        const fallbackId = resolvePreferredEditorId(refreshed, editor.id);
        if (fallbackId && fallbackId !== editor.id) rememberEditor(fallbackId);
      }
    },
    [folderPath, refreshEditors, rememberEditor, workspaceId],
  );

  const openPreferredEditor = React.useCallback(async () => {
    let editor = preferredEditor;
    if (!editor) {
      const refreshed = await refreshEditors(true);
      const resolvedId = refreshed ? resolvePreferredEditorId(refreshed, storedEditorId) : null;
      editor = refreshed?.find((candidate) => candidate.id === resolvedId);
    }
    if (editor) await openInEditor(editor);
  }, [openInEditor, preferredEditor, refreshEditors, storedEditorId]);

  React.useEffect(
    () =>
      onNotification("app:open-workspace-preferred-editor", () => {
        void openPreferredEditor();
      }),
    [openPreferredEditor],
  );

  if (!workspaceId || !folderPath) return null;

  const isInitialLoading = isLoading && editors.length === 0;
  const disabled = isInitialLoading || !preferredEditor;

  return (
    <div
      role="group"
      aria-label="Open workspace in editor"
      className="glass-surface flex h-9 shrink-0 overflow-hidden rounded-pill shadow-sm"
    >
      <Button
        variant="transparent"
        size="large"
        radius="rounded"
        disabled={disabled}
        onClick={() => void openPreferredEditor()}
        aria-label={
          preferredEditor
            ? `Open workspace in ${preferredEditor.label}`
            : "Open workspace in preferred editor"
        }
        className="h-9 rounded-l-pill rounded-r-none border-0 px-2.5 hover:bg-control/70 active:bg-control-active"
      >
        {preferredEditor ? (
          <EditorIcon editor={preferredEditor} className="size-[18px] shrink-0 rounded-[4px]" />
        ) : (
          <span
            aria-hidden="true"
            className="size-[18px] shrink-0 animate-pulse rounded-[4px] bg-control"
          />
        )}
        <span className="open-in-editor-label">Open</span>
      </Button>
      <span aria-hidden="true" className="my-1.5 w-px shrink-0 bg-separator" />
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) void refreshEditors(true);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            iconOnly
            variant="transparent"
            size="large"
            radius="rounded"
            disabled={disabled}
            aria-label="Choose editor"
            className="h-9 w-8 rounded-l-none rounded-r-pill border-0 hover:bg-control/70 active:bg-control-active [&_svg]:size-4"
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {editors.map((editor) => (
            <DropdownMenuItem key={editor.id} onSelect={() => void openInEditor(editor)}>
              <EditorIcon editor={editor} className="size-4 shrink-0 rounded-[3px]" />
              <span className="min-w-0 flex-1 truncate">{editor.label}</span>
              {editor.id === preferredEditorId ? (
                <span className="ml-5 text-small opacity-55" aria-label="Command O">
                  ⌘O
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
