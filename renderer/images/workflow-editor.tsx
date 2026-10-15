import { useNavigate } from "@tanstack/react-router";
import type { Connection, Edge } from "@xyflow/react";
import { Plus, Redo2, Undo2 } from "lucide-react";
import * as React from "react";
import { AlertDialog, Button, Callout, EmptyState, Text } from "../components/ui";
import { StudioCanvas, StudioSurface, type CanvasTool } from "../canvas";
import { IMAGE_NODE_DEFINITIONS } from "../shared/images/ports";
import type { WorkflowPosition } from "../shared/images/schema";
import { ConsentSheet } from "./consent-sheet";
import { decideCanvasConnection } from "./editor-core";
import { WorkflowEditorContext, type WorkflowEditorContextValue } from "./editor-context";
import { deletionOp, interpretEdgeChanges, interpretNodeChanges, toFlowEdges, toFlowNodes, type WorkflowFlowNode } from "./flow-adapter-core";
import { LeaveGuard } from "./leave-guard";
import { ADDABLE_NODES, NODE_COMPONENTS } from "./nodes/registry";
import { RunPanel } from "./run-panel";
import { outputsForNode } from "./run-view-core";
import { useImageRun } from "./use-image-run";
import { useWorkflowController, type SaveState } from "./use-workflow-controller";

const SAVE_LABELS: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  conflict: "Changed elsewhere",
  error: "Not saved",
};

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
  const context = React.useMemo<WorkflowEditorContextValue>(
    () => ({
      apply: controller.apply,
      models: controller.models,
      assetUrls: controller.assetUrls,
      attempts,
      outputsFor: (nodeId) => outputsForNode(run.snapshot, controller.latestOutputs, nodeId),
      running: run.running || run.busy,
      stale: controller.staleNodeIds,
      importImage: controller.importImage,
      runFromHere: (nodeId) => run.prepare({ kind: "from-node", nodeId }),
    }),
    [controller, attempts, run],
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
    ...(controller.message ? [controller.message] : []),
    ...(controller.saveState === "error" ? ["Aiden could not save your latest changes."] : []),
    ...run.issues.map((issue) => issue.message),
  ];

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
          <div className="relative min-w-0 flex-1">
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
            {notices.length > 0 || controller.saveState === "conflict" ? (
              <Callout role="alert" color="red" className="absolute bottom-3 left-14 max-w-md">
                {notices.map((notice) => <Text key={notice}>{notice}</Text>)}
                {controller.saveState === "conflict" ? (
                  <>
                    <Text>This workflow changed somewhere else. Keep your version, or discard your changes and reload.</Text>
                    <div className="flex flex-wrap gap-1">
                      <Button size="small" variant="muted" onClick={controller.keepMine}>Keep My Version</Button>
                      <Button size="small" variant="transparent" onClick={() => setConfirmReload(true)}>Discard and Reload…</Button>
                    </div>
                  </>
                ) : (
                  <Button size="small" variant="transparent" className="self-start" onClick={() => { controller.dismissMessage(); run.clearIssues(); }}>Dismiss</Button>
                )}
              </Callout>
            ) : null}
          </div>
          <RunPanel snapshot={run.snapshot} nodeTitles={nodeTitles} onStop={run.stop} onRetry={(nodeId, kind) => run.prepare({ kind, nodeId })} />
        </div>
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
