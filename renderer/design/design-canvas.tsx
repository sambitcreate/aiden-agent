// Loaded on demand so React Flow and its CSS stay out of the entry chunk.
import "../canvas/styles";
import "./design-canvas.css";
import { type NodeChange, type ReactFlowInstance, type Viewport } from "@xyflow/react";
import * as React from "react";
import { StudioCanvas, type CanvasTool } from "../canvas";
import type { CanvasKeyEvent } from "../canvas/canvas-keymap-core";
import { EmptyState, toast } from "../components/ui";
import { isMacPlatform } from "../lib/ghostty-terminal/host-platform";
import { prefersReducedMotion } from "../lib/appearance-runtime";
import { designCanvasApi } from "../lib/ipc";
import {
  addPage,
  deletePage,
  duplicatePage,
  movePage,
  renamePage,
  showPage,
} from "../shared/design-canvas/pages";
import { activeDesignPage, framesOnPage, withActiveViewport } from "../shared/design-canvas/schema";
import type { DesignCanvas as CanvasDocument, DesignFrame } from "../shared/design-canvas/schema";
import {
  applyNodeChanges,
  duplicateFrames,
  nodesFromCanvas,
  placeFrame,
  type DesignNode,
  type PlaceFrameInput,
} from "./canvas-adapter-core";
import { resolveDesignCanvasKey } from "./canvas-keymap-core";
import { canvasFocusFrom, forgetCanvasFocus, takeCanvasFocus, type CanvasFocusRequest } from "./canvas-focus-requests";
import { DesignCanvasEmpty } from "./design-canvas-empty";
import { useDesignComments } from "./design-comments";
import { DesignToolbar, type DesignAddKind, type DesignPageAction } from "./design-toolbar";
import { selectLiveFrames } from "./live-set-core";
import { DesignNodeContext, DESIGN_DEFAULT_WIDTH, type DesignNodeContextValue } from "./nodes/design-node-context";
import { designNodeTypes } from "./nodes/registry";
import { useDesignCanvas } from "./use-design-canvas";

const NO_EDGES: never[] = [];

/** The design canvas for one chat. */
export default function DesignCanvas({ chatId }: { chatId: string }) {
  const canvas = useDesignCanvas(chatId);
  if (!canvas.doc) {
    // The landmark stays the same while the canvas loads or fails, so focus and
    // assistive tech find it in one place.
    return (
      <div role="region" aria-label="Design canvas" className="flex h-full items-center justify-center">
        {canvas.status === "error" ? (
          <EmptyState
            role="alert"
            title="The canvas couldn't load."
            description="Close design mode and open it again to retry."
          />
        ) : (
          <div role="status" aria-label="Loading canvas">
            <div aria-hidden className="h-24 w-40 animate-pulse rounded-button bg-control motion-reduce:animate-none" />
          </div>
        )}
      </div>
    );
  }
  return <LoadedDesignCanvas chatId={chatId} doc={canvas.doc} canvas={canvas} />;
}

type CanvasHandle = ReturnType<typeof useDesignCanvas>;

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

const PICK_ERRORS = {
  "outside-workspace": "Choose a file inside this chat's workspace.",
  unsupported: "That file can't be shown on the canvas.",
  unavailable: "Files can't be added to this chat's canvas.",
} as const;

/** Aiden's canvas_focus waits this long after the person last touched the canvas. */
const FOCUS_QUIET_MS = 3_000;
/** How long canvas_focus waits for frames that are still on their way. */
const FOCUS_WAIT_MS = 3_000;

function LoadedDesignCanvas({
  chatId,
  doc,
  canvas,
}: {
  chatId: string;
  doc: CanvasDocument;
  canvas: CanvasHandle;
}) {
  const { change, undo, redo } = canvas;
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [minimap, setMinimap] = React.useState(false);
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(() => new Set());
  const [entered, setEntered] = React.useState<string | null>(null);
  const [versions, setVersions] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const [missing, setMissing] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const [grant, setGrant] = React.useState<string | null>(null);
  const [autoFocusId, setAutoFocusId] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [viewport, setViewport] = React.useState<Viewport>(() => activeDesignPage(doc).viewport);
  const [viewSize, setViewSize] = React.useState({ w: 0, h: 0 });
  const [live, setLive] = React.useState<ReadonlySet<string>>(() => new Set());

  const wrapper = React.useRef<HTMLDivElement | null>(null);
  const flow = React.useRef<ReactFlowInstance<DesignNode> | null>(null);
  const latestViewport = React.useRef<Viewport>(activeDesignPage(doc).viewport);
  const moveFrame = React.useRef<number | null>(null);
  const gesture = React.useRef(false);

  // The chat's grant: frames load their pages and images through it.
  React.useEffect(() => {
    let cancelled = false;
    void designCanvasApi.getDesignCanvasGrant(chatId).then(
      (answer) => {
        if (!cancelled && "grant" in answer) setGrant(answer.grant);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  // A save that fails says so once; the next edit tries again.
  React.useEffect(() => {
    if (canvas.status === "error") toast.error("The canvas couldn't save your latest changes.");
  }, [canvas.status]);

  // Watch every framed page and image; a change reloads just that path.
  const watchedKey = React.useMemo(() => {
    const paths: string[] = [];
    for (const frame of doc.frames) {
      if ((frame.kind === "file" || frame.kind === "image") && frame.path && !paths.includes(frame.path)) {
        paths.push(frame.path);
      }
    }
    return paths.join("\n");
  }, [doc.frames]);
  React.useEffect(() => {
    void designCanvasApi.watchDesignFiles(chatId, watchedKey ? watchedKey.split("\n") : []).catch(() => undefined);
  }, [chatId, watchedKey]);
  React.useEffect(
    () => () => {
      void designCanvasApi.watchDesignFiles(chatId, []).catch(() => undefined);
    },
    [chatId],
  );
  React.useEffect(
    () =>
      designCanvasApi.onDesignFilesChanged((update) => {
        if (update.chatId !== chatId || update.paths.length === 0) return;
        setVersions((current) => {
          const next = new Map(current);
          for (const path of update.paths) next.set(path, (next.get(path) ?? 0) + 1);
          return next;
        });
      }),
    [chatId],
  );

  // Aiden's canvas_read {snapshot: true}: a picture of the canvas region, or
  // null when it is not on screen (the Chat tab of the stacked view, say).
  React.useEffect(
    () =>
      designCanvasApi.onDesignCanvasSnapshot((request) => {
        if (request?.chatId !== chatId || typeof request.requestId !== "string") return;
        const answer = (dataUrl: string | null) =>
          void designCanvasApi.answerDesignCanvasSnapshot(request.requestId, dataUrl).catch(() => undefined);
        const rect = wrapper.current?.getBoundingClientRect();
        if (!rect || rect.width < 1 || rect.height < 1 || document.visibilityState === "hidden") {
          answer(null);
          return;
        }
        void designCanvasApi
          .captureDesignFrame({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          .then((shot) => answer("dataUrl" in shot ? shot.dataUrl : null), () => answer(null));
      }),
    [chatId],
  );

  // The canvas's size on screen, for the live set and for placing frames.
  React.useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setViewSize((current) =>
        current.w === rect.width && current.h === rect.height ? current : { w: rect.width, h: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  React.useEffect(
    () => () => {
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  const versionOf = React.useCallback(
    (path: string | undefined) => (path ? (versions.get(path) ?? 0) : 0),
    [versions],
  );

  // Another page on screen (the picker, an undo, or Aiden's canvas_focus):
  // go to where that page was left, with nothing selected or entered.
  const shownPage = React.useRef(doc.activePageId);
  React.useEffect(() => {
    if (shownPage.current === doc.activePageId) return;
    shownPage.current = doc.activePageId;
    const next = activeDesignPage(doc).viewport;
    latestViewport.current = next;
    setViewport(next);
    void flow.current?.setViewport(next, { duration: 0 });
    setSelection((current) => (current.size === 0 ? current : new Set()));
    setEntered(null);
    setRenaming(null);
    // Only a change of page moves the view; the doc's other changes do not.
  }, [doc]);

  // At most six frames run a real page; the rest show their snapshots.
  React.useEffect(() => {
    const frames = framesOnPage(doc).filter((frame) => missing.get(frame.id) !== versionOf(frame.path));
    setLive((previous) => {
      const next = selectLiveFrames({ frames, viewport, view: viewSize, selected: selection, entered, previous });
      return sameSet(previous, next) ? previous : next;
    });
  }, [doc, missing, versionOf, viewport, viewSize, selection, entered]);

  const nodes = React.useMemo(() => nodesFromCanvas(doc, selection), [doc, selection]);
  const comments = useDesignComments({ chatId, doc, change, flow, wrapper, live, versionOf });
  const toggleComments = () => {
    const next = !comments.active;
    comments.setActive(next);
    if (!next) return;
    setTool("select");
    setEntered(null);
    setSelection((current) => (current.size === 0 ? current : new Set()));
  };
  const changeTool = (next: CanvasTool) => {
    comments.setActive(false);
    setTool(next);
  };

  // Aiden's canvas_focus: fit the frames it names once they have arrived,
  // unless the person moved around the canvas in the last few seconds.
  const lastInteraction = React.useRef(0);
  const noteInteraction = React.useCallback(() => {
    lastInteraction.current = Date.now();
  }, []);
  // A request that arrived while this canvas was still loading counts too.
  const [pendingFocus, setPendingFocus] = React.useState<CanvasFocusRequest | null>(() =>
    takeCanvasFocus(chatId, FOCUS_WAIT_MS),
  );
  React.useEffect(
    () =>
      designCanvasApi.onDesignCanvasFocus((payload) => {
        const parsed = canvasFocusFrom(payload);
        if (parsed?.chatId !== chatId) return;
        forgetCanvasFocus(chatId);
        setPendingFocus(parsed.request);
      }),
    [chatId],
  );
  React.useEffect(() => {
    if (!pendingFocus) return;
    if (gesture.current || Date.now() - lastInteraction.current < FOCUS_QUIET_MS) {
      setPendingFocus(null);
      return;
    }
    const present = pendingFocus.ids.filter((id) => nodes.some((node) => node.id === id));
    // Frames Aiden just placed arrive with the next canvas read, and a canvas
    // that just opened has not measured them yet; wait briefly for both.
    const waited = Date.now() - pendingFocus.at;
    const measured = flow.current?.getNodes().some((node) => (node.measured?.width ?? 0) > 0) ?? false;
    const arriving = present.length < pendingFocus.ids.length || (nodes.length > 0 && !measured);
    if (arriving && waited < FOCUS_WAIT_MS) {
      const timer = setTimeout(() => setPendingFocus((current) => (current ? { ...current } : current)), 200);
      return () => clearTimeout(timer);
    }
    setPendingFocus(null);
    if (pendingFocus.ids.length > 0 && present.length === 0) return;
    // Never zoom past 100 %: a single note should not fill the canvas.
    void flow.current?.fitView({
      duration: prefersReducedMotion() ? 0 : 300,
      padding: 0.2,
      maxZoom: 1,
      ...(present.length > 0 ? { nodes: present.map((id) => ({ id })) } : {}),
    });
  }, [pendingFocus, nodes]);

  const onNodesChange = (changes: NodeChange<DesignNode>[]) => {
    const selects = changes.filter((entry) => entry.type === "select");
    if (selects.length > 0) {
      setSelection((current) => {
        const next = new Set(current);
        for (const entry of selects) {
          if (entry.selected) next.add(entry.id);
          else next.delete(entry.id);
        }
        return sameSet(current, next) ? current : next;
      });
    }
    const edits = changes.filter((entry) => entry.type !== "select");
    if (edits.length === 0) return;
    // One undo step per drag or resize, taken when it starts.
    const flags = edits.map((entry) =>
      entry.type === "position" ? entry.dragging : entry.type === "dimensions" ? entry.resizing : undefined,
    );
    let record = true;
    if (flags.includes(true)) {
      record = !gesture.current;
      gesture.current = true;
    } else if (flags.includes(false)) {
      record = !gesture.current;
      gesture.current = false;
    }
    change((current) => applyNodeChanges(current, edits), { record });
  };

  const removeFrames = React.useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      change((current) => applyNodeChanges(current, ids.map((id) => ({ type: "remove" as const, id }))));
      setSelection((current) => {
        const next = new Set([...current].filter((id) => !ids.includes(id)));
        return sameSet(current, next) ? current : next;
      });
      setEntered((current) => (current !== null && ids.includes(current) ? null : current));
    },
    [change],
  );

  const add = (frame: PlaceFrameInput): string | null => {
    const current = latestViewport.current;
    const zoom = current.zoom || 1;
    const view = { x: -current.x / zoom, y: -current.y / zoom, w: viewSize.w / zoom, h: viewSize.h / zoom };
    // The id is fixed up front: an edit replayed after a save conflict places the same frame.
    const id = crypto.randomUUID();
    let placed = false;
    change((latest) => {
      const result = placeFrame(latest, frame, view, () => id);
      if ("error" in result) return latest;
      placed = true;
      return result.doc;
    });
    if (!placed) {
      toast.error("This canvas is full. Remove a frame to add another.");
      return null;
    }
    setSelection(new Set([id]));
    return id;
  };

  const pick = async (kind: "file" | "image") => {
    let answer: Awaited<ReturnType<typeof designCanvasApi.pickDesignFile>>;
    try {
      answer = await designCanvasApi.pickDesignFile(chatId, kind);
    } catch {
      toast.error(PICK_ERRORS.unavailable);
      return;
    }
    if ("cancelled" in answer) return;
    if ("error" in answer) {
      toast.error(PICK_ERRORS[answer.error]);
      return;
    }
    const title = basename(answer.path);
    if (kind === "file") {
      add({
        kind: "file",
        title,
        path: answer.path,
        designWidth: DESIGN_DEFAULT_WIDTH,
        w: 640,
        h: 436,
        createdBy: "person",
      });
    } else {
      add({ kind: "image", title, path: answer.path, w: 320, h: 240, createdBy: "person" });
    }
  };

  const onPage = (action: DesignPageAction) => {
    switch (action.type) {
      case "show":
        change((current) => showPage(current, action.id), { record: false });
        return;
      case "add": {
        // The id is fixed up front so an edit replayed after a save conflict adds the same page.
        const id = crypto.randomUUID();
        change((current) => addPage(current, id));
        return;
      }
      case "rename":
        change((current) => renamePage(current, action.id, action.name));
        return;
      case "duplicate": {
        const pageId = crypto.randomUUID();
        const ids: string[] = [];
        let made = true;
        change((current) => {
          let index = 0;
          const next = duplicatePage(current, action.id, pageId, () => (ids[index++] ??= crypto.randomUUID()));
          made = next !== current;
          return next;
        });
        if (!made) toast.error("This canvas is full. Remove some frames to copy this page.");
        return;
      }
      case "move":
        change((current) => movePage(current, action.id, action.step));
        return;
      case "delete": {
        const name = doc.pages.find((page) => page.id === action.id)?.name ?? "Page";
        change((current) => deletePage(current, action.id));
        toast(`Deleted "${name}"`, { action: { label: "Undo", onClick: () => undo() } });
        return;
      }
    }
  };

  const onAdd = (kind: DesignAddKind) => {
    if (kind === "note") {
      const id = add({ kind: "note", title: "Note", text: "", w: 240, h: 160, createdBy: "person" });
      if (id !== null) setAutoFocusId(id);
    } else if (kind === "group") {
      add({ kind: "group", title: "Group", w: 640, h: 400, createdBy: "person" });
    } else {
      void pick(kind);
    }
  };

  const resolveKey = (event: CanvasKeyEvent, context: { editable: boolean }) => {
    const command = resolveDesignCanvasKey(event, {
      editable: context.editable,
      platform: isMacPlatform() ? "darwin" : "other",
    });
    if (!command) return false;
    switch (command.type) {
      case "undo":
        undo();
        return true;
      case "redo":
        redo();
        return true;
      case "duplicate":
        if (selection.size > 0) {
          // Ids are kept across calls so an edit replayed after a save conflict makes the same copies.
          const ids: string[] = [];
          const selected = [...selection];
          change((current) => {
            let index = 0;
            return duplicateFrames(current, selected, () => (ids[index++] ??= crypto.randomUUID()));
          });
        }
        return true;
      case "delete":
        if (selection.size === 0) return false;
        removeFrames([...selection]);
        return true;
      case "fitSelection":
        void flow.current?.fitView({
          duration: 0,
          padding: 0.2,
          ...(selection.size > 0 ? { nodes: [...selection].map((id) => ({ id })) } : {}),
        });
        return true;
      case "enter": {
        // Enter does what a double-click does: a selected page or artifact takes input.
        if (selection.size !== 1) return false;
        const [id] = selection;
        const frame = doc.frames.find((entry) => entry.id === id);
        if (!frame || (frame.kind !== "file" && frame.kind !== "artifact")) return false;
        if (frame.kind === "file" && missing.get(frame.id) === versionOf(frame.path)) return false;
        setEntered(frame.id);
        return true;
      }
      case "rename": {
        if (selection.size !== 1) return false;
        const [id] = selection;
        setRenaming(id ?? null);
        return true;
      }
      case "addNote":
        onAdd("note");
        return true;
      case "comment":
        toggleComments();
        return true;
      case "escape":
        if (comments.escape()) return true;
        if (entered !== null) setEntered(null);
        else if (selection.size > 0) setSelection(new Set());
        else return false;
        return true;
      default:
        // The shared canvas keys (tools, zoom, minimap) are the canvas's own.
        return false;
    }
  };

  const update = React.useCallback<DesignNodeContextValue["update"]>(
    (id, patch, { record }) =>
      change(
        (current) => {
          let changed = false;
          const frames = current.frames.map((frame): DesignFrame => {
            if (frame.id !== id) return frame;
            const next = { ...frame, ...patch };
            if (next.text === frame.text && next.title === frame.title) return frame;
            changed = true;
            return next;
          });
          return changed ? { ...current, frames } : current;
        },
        { record },
      ),
    [change],
  );

  const context = React.useMemo<DesignNodeContextValue>(
    () => ({
      chatId,
      grant,
      live,
      entered,
      versionOf,
      autoFocusId,
      enter: setEntered,
      markMissing: (id, version) =>
        setMissing((current) => (current.get(id) === version ? current : new Map(current).set(id, version))),
      remove: (id) => removeFrames([id]),
      update,
      autoFocusDone: (id) => setAutoFocusId((current) => (current === id ? null : current)),
      renaming,
      rename: setRenaming,
    }),
    [chatId, grant, live, entered, versionOf, autoFocusId, removeFrames, update, renaming],
  );

  return (
    // Its letter, digit and +/- keys are the canvas's own, so the chat's composer leaves them alone.
    <div
      ref={wrapper}
      data-typing-surface="canvas"
      className={comments.active ? "design-commenting h-full w-full" : "h-full w-full"}
      onPointerDownCapture={noteInteraction}
      onWheelCapture={noteInteraction}
      onKeyDownCapture={noteInteraction}
    >
      <DesignNodeContext.Provider value={context}>
        <StudioCanvas<DesignNode>
          label="Design canvas"
          tool={tool}
          onToolChange={changeTool}
          minimap={minimap}
          onMinimapChange={setMinimap}
          nodes={nodes}
          edges={NO_EDGES}
          nodeTypes={designNodeTypes}
          onNodesChange={onNodesChange}
          onInit={(instance) => {
            flow.current = instance;
          }}
          defaultViewport={activeDesignPage(doc).viewport}
          onMove={(_event, next) => {
            latestViewport.current = next;
            if (moveFrame.current !== null) return;
            moveFrame.current = requestAnimationFrame(() => {
              moveFrame.current = null;
              setViewport(latestViewport.current);
            });
          }}
          onMoveEnd={(_event, next) => {
            latestViewport.current = next;
            change((current) => withActiveViewport(current, { x: next.x, y: next.y, zoom: next.zoom }), {
              record: false,
            });
          }}
          onPaneClick={(event) => {
            if (comments.onPaneClick(event)) return;
            setEntered(null);
          }}
          onNodeClick={(event, node) => {
            comments.onNodeClick(event, node);
          }}
          onNodeMouseMove={comments.onNodeMouseMove}
          onNodeMouseLeave={comments.onNodeMouseLeave}
          nodesDraggable={!comments.active}
          elementsSelectable={!comments.active}
          deleteKeyCode={null}
          elevateNodesOnSelect={false}
          zoomOnDoubleClick={false}
          resolveKey={resolveKey}
          emptyState={<DesignCanvasEmpty />}
          toolbar={
            <DesignToolbar
              doc={doc}
              tool={tool}
              onToolChange={changeTool}
              commenting={comments.active}
              onComment={toggleComments}
              onOpenComment={comments.open}
              canAddFiles={grant !== null}
              onAdd={onAdd}
              onPage={onPage}
            />
          }
        >
          {comments.layer}
        </StudioCanvas>
      </DesignNodeContext.Provider>
    </div>
  );
}
