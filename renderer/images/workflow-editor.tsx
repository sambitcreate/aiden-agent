import { useNavigate } from "@tanstack/react-router";
import type { Connection, Edge } from "@xyflow/react";
import { ImagePlus, Plus, Redo2, Undo2 } from "lucide-react";
import * as React from "react";
import { AlertDialog, Button, Callout, EmptyState, Text } from "../components/ui";
import { StudioCanvas, StudioSurface, type CanvasTool } from "../canvas";
import { IMAGE_NODE_DEFINITIONS } from "../shared/images/ports";
import type { WorkflowPosition } from "../shared/images/schema";
import { ConsentSheet } from "./consent-sheet";
import { decideCanvasConnection } from "./editor-core";
import { WorkflowEditorContext, type WorkflowEditorContextValue } from "./editor-context";
import { viewerItemsForOutputs } from "./gallery-core";
import { HistoryPanel } from "./history-panel";
import { deletionOp, interpretEdgeChanges, interpretNodeChanges, toFlowEdges, toFlowNodes, type WorkflowFlowNode } from "./flow-adapter-core";
import { LeaveGuard } from "./leave-guard";
import { ADDABLE_NODES, NODE_COMPONENTS } from "./nodes/registry";
import { RunPanel } from "./run-panel";
import { EditorSidePanel, type SidePanelTab } from "./side-panel";
import { useGallery } from "./use-gallery";
import { issueNotices, outputsForNode } from "./run-view-core";
import { useImageRun } from "./use-image-run";
import { useWorkflowController, type SaveState } from "./use-workflow-controller";
import { ImageViewer, type ViewerAction } from "./viewer/image-viewer";
import { REVEAL_LABEL, useImageActions } from "./viewer/use-image-actions";

const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  conflict: "Changed elsewhere",
  deleted: "Deleted",
  error: "Not saved",
};

/** What the viewer shows: one Output node's images or the whole history, at one image. */
type ViewerState = { source: { kind: "node"; nodeId: string } | { kind: "history" }; assetId: string };

const connectionOf = (connection: Connection | Edge) => ({
  source: connection.source,
  sourcePort: connection.sourceHandle ?? "",
  target: connection.target,
  targetPort: connection.targetHandle ?? "",
});

export function WorkflowEditor({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate();
  const controller = useWorkflowController(workflowId);
  const run = useImageRun(workflowId, controller);
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [minimap, setMinimap] = React.useState(false);
  const [dragging, setDragging] = React.useState<Map<string, WorkflowPosition>>(new Map());
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [measured, setMeasured] = React.useState<Map<string, { width: number; height: number }>>(new Map());
  const [confirmReload, setConfirmReload] = React.useState(false);
  const [sideTab, setSideTab] = React.useState<SidePanelTab>("run");
  const [viewer, setViewer] = React.useState<ViewerState | null>(null);
  const gallery = useGallery(workflowId);
  const imageActions = useImageActions({ onSaved: gallery.refresh });
  const canvasPane = React.useRef<HTMLDivElement>(null);
  // React Flow reports edge and node changes back to back in one tick; both read the latest transient state.
  const flowState = React.useRef({ dragging, selected, measured });
  flowState.current = { dragging, selected, measured };
  // Run All and Stop share one button so focus stays on it when a run starts or ends.
  const runAction = React.useRef<HTMLButtonElement>(null);
  const doc = controller.doc;

  const flowNodes = React.useMemo(() => (doc ? toFlowNodes(doc, dragging, selected, measured) : []), [doc, dragging, selected, measured]);
  const flowEdges = React.useMemo(() => (doc ? toFlowEdges(doc, selected) : []), [doc, selected]);
  const attempts = React.useMemo(
    () => new Map((run.snapshot?.attempts ?? []).map((attempt) => [attempt.nodeId, attempt])),
    [run.snapshot],
  );
  // Every node reads this context, so it changes only when what nodes show changes: typing in
  // one prompt or dragging a node re-renders that node, not all of them.
  const { apply, models, assetUrls, latestOutputs, staleNodeIds, importImage } = controller;
  const { snapshot, prepare } = run;
  const running = run.running || run.busy;
  const outputsFor = React.useCallback((nodeId: string) => outputsForNode(snapshot, latestOutputs, nodeId), [snapshot, latestOutputs]);
  const runFromHere = React.useCallback((nodeId: string) => prepare({ kind: "from-node", nodeId }), [prepare]);
  const openImage = React.useCallback(
    (nodeId: string, index: number) => {
      const image = outputsFor(nodeId)[index];
      if (image) setViewer({ source: { kind: "node", nodeId }, assetId: image.assetId });
    },
    [outputsFor],
  );
  const { saveAs, copy, reveal } = imageActions;
  const nodeImageActions = React.useMemo(() => ({ saveAs, copy, reveal, revealLabel: REVEAL_LABEL }), [saveAs, copy, reveal]);
  const context = React.useMemo<WorkflowEditorContextValue>(
    () => ({ apply, models, assetUrls, attempts, outputsFor, running, stale: staleNodeIds, importImage, runFromHere, openImage, imageActions: nodeImageActions }),
    [apply, models, assetUrls, attempts, outputsFor, running, staleNodeIds, importImage, runFromHere, openImage, nodeImageActions],
  );
  // Resolved on every render, so a gallery refresh fills in details while the viewer is open.
  const viewerItems = React.useMemo(() => {
    if (!viewer) return [];
    if (viewer.source.kind === "history") return gallery.items;
    return viewerItemsForOutputs(outputsFor(viewer.source.nodeId), {
      gallery: gallery.items, workflowId, nodeId: viewer.source.nodeId, assetUrls, attempts: snapshot?.attempts ?? [], runId: snapshot?.run.runId, runState: snapshot?.run.state,
    });
  }, [viewer, gallery.items, outputsFor, workflowId, assetUrls, snapshot]);
  const viewerOpen = viewer !== null && viewerItems.length > 0;
  const viewerIndex = viewerOpen ? Math.max(0, viewerItems.findIndex((item) => item.assetId === viewer.assetId)) : null;
  const { addImageInput } = controller;
  const viewerActions = React.useMemo<ViewerAction[]>(
    () => [{
      id: "use-as-input",
      label: "Use as Input",
      icon: <ImagePlus aria-hidden="true" />,
      onSelect: (item) => {
        const pane = canvasPane.current?.getBoundingClientRect();
        addImageInput(item, item.thumbUrl || undefined, { width: pane?.width ?? 0, height: pane?.height ?? 0 });
        setViewer(null);
      },
    }],
    [addImageInput],
  );

  if (controller.status !== "ready" || !doc) {
    return (
      <StudioSurface title="Images">
        {controller.status === "error" ? (
          <EmptyState
            role="alert"
            title="This workflow could not be opened"
            description={controller.error ?? undefined}
            action={<Button onClick={() => void navigate({ to: "/images" })}>Back to Images</Button>}
          />
        ) : (
          <EmptyState placement="inline" role="status" title="Opening workflow…" />
        )}
      </StudioSurface>
    );
  }

  const nodeTitles = new Map(doc.nodes.map((node) => [node.id, node.title ?? IMAGE_NODE_DEFINITIONS[node.type].title]));
  const notices = [
    ...(controller.message ? [{ key: "message", text: controller.message }] : []),
    ...issueNotices(run.issues, nodeTitles),
  ];
  const saveError = controller.saveState === "error" ? controller.saveError : null;
  const conflict = controller.saveState === "conflict";
  const deleted = controller.saveState === "deleted";
  const dismissNotices = () => {
    controller.dismissMessage();
    controller.dismissSaveError();
    run.clearIssues();
  };

  return (
    <WorkflowEditorContext.Provider value={context}>
      <StudioSurface
        title={doc.title}
        actions={
          <>
            <Text variant="small" color="secondary">{SAVE_LABELS[controller.saveState]}</Text>
            <Button variant="transparent" iconOnly aria-label="Undo" disabled={!controller.canUndo} onClick={controller.undo}><Undo2 /></Button>
            <Button variant="transparent" iconOnly aria-label="Redo" disabled={!controller.canRedo} onClick={controller.redo}><Redo2 /></Button>
            <Button
              ref={runAction}
              variant={run.running ? "muted" : "accent"}
              disabled={!run.running && run.busy}
              onClick={run.running ? run.stop : () => run.prepare({ kind: "all" })}
            >
              {run.running ? "Stop" : "Run All"}
            </Button>
          </>
        }
      >
        <div className="flex h-full min-h-0">
          <div ref={canvasPane} className="relative min-w-0 flex-1">
            <StudioCanvas<WorkflowFlowNode, Edge>
              label="Images canvas"
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_COMPONENTS}
              tool={tool}
              onToolChange={setTool}
              minimap={minimap}
              onMinimapChange={setMinimap}
              defaultViewport={doc.viewport ?? { x: 0, y: 0, zoom: 1 }}
              onMoveEnd={(_event, viewport) => controller.setViewport(viewport)}
              // React Flow's Backspace listener is document-wide; it must not delete nodes behind the viewer.
              deleteKeyCode={viewerOpen ? null : undefined}
              onNodesChange={(changes) => {
                const result = interpretNodeChanges(changes, flowState.current);
                flowState.current = { dragging: result.dragging, selected: result.selected, measured: result.measured };
                setDragging(result.dragging);
                setSelected(result.selected);
                setMeasured(result.measured);
                for (const op of result.ops) controller.apply(op);
              }}
              onEdgesChange={(changes) => {
                const next = interpretEdgeChanges(changes, flowState.current.selected);
                flowState.current = { ...flowState.current, selected: next };
                setSelected(next);
              }}
              onDelete={(deleted) => {
                const op = deletionOp(deleted);
                if (op) controller.apply(op);
              }}
              isValidConnection={(connection) => decideCanvasConnection(doc, connectionOf(connection), "probe").allowed}
              onConnect={(connection) => controller.apply({ type: "connect", edgeId: crypto.randomUUID(), ...connectionOf(connection) })}
              emptyState={<EmptyState placement="inline" title="Add a node to start" description="Add a Prompt, a Generate Image and an Output node, then connect them." />}
            />
            <div role="toolbar" aria-label="Add node" className="glass-surface absolute left-1/2 top-3 flex -translate-x-1/2 gap-1 rounded-button p-1 shadow-control">
              {ADDABLE_NODES.map((entry) => (
                <Button key={entry.type} size="small" variant="transparent" onClick={() => controller.addNode(entry.type)}>
                  <Plus />
                  {entry.label}
                </Button>
              ))}
            </div>
            {notices.length > 0 || saveError !== null || conflict || deleted ? (
              <Callout role="alert" color="red" className="absolute bottom-3 left-14 max-w-md">
                {notices.map((notice) => <Text key={notice.key}>{notice.text}</Text>)}
                {saveError !== null ? <Text>Aiden could not save your latest changes. {saveError}</Text> : null}
                {notices.length > 0 || saveError !== null ? (
                  <div className="flex flex-wrap gap-1">
                    {saveError !== null ? <Button size="small" variant="muted" onClick={controller.retrySave}>Retry</Button> : null}
                    <Button size="small" variant="transparent" onClick={dismissNotices}>Dismiss</Button>
                  </div>
                ) : null}
                {conflict ? (
                  <>
                    <Text>This workflow changed somewhere else. Keep your version, or discard your changes and reload.</Text>
                    <div className="flex flex-wrap gap-1">
                      <Button size="small" variant="muted" disabled={controller.resolving} onClick={controller.keepMine}>Keep My Version</Button>
                      <Button size="small" variant="transparent" disabled={controller.resolving} onClick={() => setConfirmReload(true)}>Discard and Reload…</Button>
                    </div>
                  </>
                ) : null}
                {deleted ? (
                  <>
                    <Text>This workflow was deleted, so your changes cannot be saved.</Text>
                    <Button
                      size="small"
                      variant="muted"
                      className="self-start"
                      onClick={() => {
                        // Nothing is left to save to; leaving drops the edits instead of asking.
                        controller.discard();
                        void navigate({ to: "/images" });
                      }}
                    >
                      Back to Images
                    </Button>
                  </>
                ) : null}
              </Callout>
            ) : null}
          </div>
          <EditorSidePanel
            tab={sideTab}
            onTabChange={setSideTab}
            run={run.snapshot ? (
              <RunPanel snapshot={run.snapshot} nodeTitles={nodeTitles} busy={run.busy} onStop={run.stop} onRetry={(nodeId, kind) => run.prepare({ kind, nodeId })} />
            ) : null}
            history={
              <HistoryPanel
                status={gallery.status}
                items={gallery.items}
                saveFolderLabel={gallery.saveFolderLabel}
                onOpen={(index) => {
                  const item = gallery.items[index];
                  if (item) setViewer({ source: { kind: "history" }, assetId: item.assetId });
                }}
                onSaveAll={imageActions.saveAll}
                onRevealFolder={imageActions.revealFolder}
                onRetry={gallery.refresh}
              />
            }
          />
        </div>
        <ImageViewer
          items={viewerItems}
          index={viewerIndex}
          onIndexChange={(index) => {
            const item = viewerItems[index];
            if (item && viewer) setViewer({ ...viewer, assetId: item.assetId });
          }}
          onClose={() => setViewer(null)}
          actions={imageActions}
          models={models}
          saveFolderLabel={gallery.saveFolderLabel}
          extraActions={viewerActions}
        />
        <ConsentSheet plan={run.plan} busy={run.busy} onCancel={run.dismiss} onConfirm={run.confirm} returnFocus={() => runAction.current} />
        <AlertDialog
          open={confirmReload}
          onOpenChange={setConfirmReload}
          title="Discard your changes?"
          description={`Your unsaved changes to “${doc.title}” are lost, and the version saved elsewhere opens.`}
          confirmLabel="Discard and Reload"
          confirmVariant="destructive"
          onConfirm={() => {
            setConfirmReload(false);
            controller.discardAndReload();
          }}
        />
        <LeaveGuard title={doc.title} controller={controller} />
      </StudioSurface>
    </WorkflowEditorContext.Provider>
  );
}
