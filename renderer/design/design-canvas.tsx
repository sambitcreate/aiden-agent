// Loaded on demand so React Flow and its CSS stay out of the entry chunk.
import "../canvas/styles";
import "./design-canvas.css";
import { getViewportForBounds, type NodeChange, type ReactFlowInstance, type Viewport } from "@xyflow/react";
import * as React from "react";
import { StudioCanvas, type CanvasTool } from "../canvas";
import type { CanvasKeyEvent } from "../canvas/canvas-keymap-core";
import { CANVAS_MIN_ZOOM } from "../canvas/canvas-viewport-core";
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
import { attachTargetAt, syncConnectors, type DesignPoint } from "../shared/design-canvas/connectors";
import type { DesignExportFormat } from "../shared/design-canvas/frame-export";
import { presentationOrder } from "../shared/design-canvas/presentation";
import { containerAt, regroupFrames } from "../shared/design-canvas/drawing";
import {
  activeDesignPage,
  framesOnPage,
  isDesignContainer,
  withActiveViewport,
} from "../shared/design-canvas/schema";
import type { DesignCanvas as CanvasDocument, DesignConnectorEnd, DesignFrame } from "../shared/design-canvas/schema";
import {
  applyNodeChanges,
  duplicateFrames,
  nodesFromCanvas,
  placeFrame,
  presentedFrameIds,
  type DesignNode,
  type PlaceFrameInput,
} from "./canvas-adapter-core";
import { readDesignArtifactTheme } from "./artifact-theme";
import { resolveDesignCanvasKey } from "./canvas-keymap-core";
import { canvasFocusFrom, forgetCanvasFocus, takeCanvasFocus, type CanvasFocusRequest } from "./canvas-focus-requests";
import { DesignCanvasEmpty } from "./design-canvas-empty";
import { frameIframe, useDesignComments } from "./design-comments";
import { usePageTextEdits } from "./page-text-edits";
import { designFrameSnapshots } from "./frame-snapshots";
import { useDesignDrawing, type DesignDrawTool } from "./design-drawing";
import { DesignPresentBar, DesignPresentButton, presentationKey, type DesignPresentation } from "./design-present";
import {
  DESIGN_PANEL_TABS,
  DesignPanelButton,
  DesignSidePanel,
  type DesignFrameSourceResult,
  type DesignPanelTab,
} from "./design-side-panel";
import { reorderLayer, stepLayer, type DesignLayerPlace } from "./layers-core";
import { DesignToolbar, type DesignAddKind, type DesignPageAction } from "./design-toolbar";
import { selectLiveFrames } from "./live-set-core";
import {
  DesignNodeContext,
  DESIGN_DEFAULT_WIDTH,
  DESIGN_FRAME_HEADER_PX,
  type DesignNodeContextValue,
} from "./nodes/design-node-context";
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
/**
 * How many times each framed file changed since the canvas opened, which its
 * frames' addresses carry. A frame that already shows its own text edit keeps
 * the version it loaded (`kept`) until the file changes again.
 */
type FileVersions = {
  paths: ReadonlyMap<string, number>;
  kept: ReadonlyMap<string, { path: string; shows: number }>;
};

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

const EXPORT_ERRORS = {
  unsaved: "The canvas couldn't be saved, so this frame can't be downloaded yet.",
  unavailable: "This frame can't be downloaded.",
  missing: "This frame's file is gone, so it can't be downloaded.",
  failed: "The download couldn't be saved. Try again.",
} as const;

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
  const { undo, redo, flush } = canvas;
  // A recorded change on the canvas comes after any words written into a
  // page's file, so ⌘Z undoes the canvas change before those.
  const forgetTextEdits = React.useRef<() => void>(() => undefined);
  const changeDoc = canvas.change;
  const change = React.useCallback<CanvasHandle["change"]>(
    (mutate, options) => {
      if (options?.record === false) {
        changeDoc(mutate, options);
        return;
      }
      // Only a change that alters the canvas counts, and only the first time
      // it runs: a later save replays the same change.
      let first = true;
      changeDoc((current) => {
        const next = mutate(current);
        if (first && next !== current) forgetTextEdits.current();
        first = false;
        return next;
      }, options);
    },
    [changeDoc],
  );
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [minimap, setMinimap] = React.useState(false);
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(() => new Set());
  const [entered, setEntered] = React.useState<string | null>(null);
  const [versions, setVersions] = React.useState<FileVersions>(() => ({ paths: new Map(), kept: new Map() }));
  const [missing, setMissing] = React.useState<ReadonlyMap<string, number>>(() => new Map());
  const [grant, setGrant] = React.useState<string | null>(null);
  const [autoFocusId, setAutoFocusId] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [drawTool, setDrawTool] = React.useState<DesignDrawTool | null>(null);
  const [viewport, setViewport] = React.useState<Viewport>(() => activeDesignPage(doc).viewport);
  const [viewSize, setViewSize] = React.useState({ w: 0, h: 0 });
  const [live, setLive] = React.useState<ReadonlySet<string>>(() => new Set());
  const [presentation, setPresentation] = React.useState<DesignPresentation | null>(null);
  const [panel, setPanel] = React.useState(readPanelState);
  React.useEffect(() => writePanelState(panel), [panel]);
  const presentingRef = React.useRef(false);
  presentingRef.current = presentation !== null;

  const wrapper = React.useRef<HTMLDivElement | null>(null);
  const flow = React.useRef<ReactFlowInstance<DesignNode> | null>(null);
  const latestViewport = React.useRef<Viewport>(activeDesignPage(doc).viewport);
  const moveFrame = React.useRef<number | null>(null);
  const gesture = React.useRef(false);
  const latestDoc = React.useRef(doc);
  latestDoc.current = doc;

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
  /** Reloads every frame of these files, except `keep`: a frame of one of them that already shows the change. */
  const reloadPaths = React.useCallback((paths: readonly string[], keep?: string) => {
    if (paths.length === 0) return;
    setVersions((current) => {
      const next = new Map(current.paths);
      const kept = new Map(current.kept);
      for (const path of paths) {
        const before = next.get(path) ?? 0;
        next.set(path, before + 1);
        const shown = kept.get(keep ?? "");
        // Any later change of the file reloads every frame of it, a kept one too.
        for (const [frameId, held] of kept) if (held.path === path) kept.delete(frameId);
        if (keep !== undefined) kept.set(keep, { path, shows: shown?.path === path ? shown.shows : before });
      }
      return { paths: next, kept };
    });
  }, []);
  React.useEffect(
    () =>
      designCanvasApi.onDesignFilesChanged((update) => {
        if (update.chatId !== chatId) return;
        reloadPaths(update.paths);
      }),
    [chatId, reloadPaths],
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
    (path: string | undefined) => (path ? (versions.paths.get(path) ?? 0) : 0),
    [versions],
  );
  const frameVersionOf = React.useCallback(
    (frame: Pick<DesignFrame, "id" | "path">) => {
      if (!frame.path) return 0;
      const held = versions.kept.get(frame.id);
      return held?.path === frame.path ? held.shows : (versions.paths.get(frame.path) ?? 0);
    },
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
    setEditing(null);
    // Only a change of page moves the view; the doc's other changes do not.
  }, [doc]);

  // At most six frames run a real page; the rest show their snapshots.
  React.useEffect(() => {
    // A hidden frame is not drawn, so it never runs its page.
    const frames = framesOnPage(doc).filter((frame) => !frame.hidden && missing.get(frame.id) !== frameVersionOf(frame));
    setLive((previous) => {
      const next = selectLiveFrames({ frames, viewport, view: viewSize, selected: selection, entered, previous });
      return sameSet(previous, next) ? previous : next;
    });
  }, [doc, missing, frameVersionOf, viewport, viewSize, selection, entered]);

  const nodes = React.useMemo(() => nodesFromCanvas(doc, selection), [doc, selection]);
  const comments = useDesignComments({ chatId, doc, change, flow, wrapper, live, versionOf });
  const pageWindow = React.useCallback((frameId: string) => frameIframe(wrapper.current, frameId)?.contentWindow ?? null, []);
  const reloadPath = React.useCallback(
    (path: string, keep?: string) => {
      // A kept frame's page now shows words its earlier picture lacks, at the
      // same version. Once it leaves the live set it must not show that
      // picture: it is captured again as it leaves, or shows its skeleton.
      if (keep !== undefined) designFrameSnapshots.forget(keep);
      reloadPaths([path], keep);
    },
    [reloadPaths],
  );
  const textEdits = usePageTextEdits({ chatId, doc, pageWindow, queueComment: comments.queueOnElement, flush, reload: reloadPath });
  forgetTextEdits.current = textEdits.forget;
  const toggleComments = () => {
    const next = !comments.active;
    comments.setActive(next);
    if (!next) return;
    setTool("select");
    setDrawTool(null);
    setEntered(null);
    setSelection((current) => (current.size === 0 ? current : new Set()));
  };
  const changeTool = (next: CanvasTool) => {
    comments.setActive(false);
    setDrawTool(null);
    setTool(next);
  };
  const chooseDrawTool = (next: DesignDrawTool) => {
    comments.setActive(false);
    setTool("select");
    setDrawTool(next);
    setEntered(null);
    setEditing(null);
    setSelection((current) => (current.size === 0 ? current : new Set()));
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
    // Measurements live on React Flow's internal nodes; the controlled nodes it hands back never carry them.
    const measuredIds = present.length > 0 ? present : nodes.map((node) => node.id);
    const measured = measuredIds.some((id) => (flow.current?.getInternalNode(id)?.measured?.width ?? 0) > 0);
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
    // A drag that ends drops each item in the group or artboard under it.
    const dropped = edits.flatMap((entry) =>
      entry.type === "position" && entry.dragging === false ? [entry.id] : [],
    );
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
    change(
      (current) => {
        const next = applyNodeChanges(current, edits);
        return dropped.length > 0 ? regroupFrames(next, dropped) : next;
      },
      { record },
    );
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

  /** Places an item a drawing tool made, at its own box, in the group or artboard it was drawn in. */
  const createDrawn = (input: PlaceFrameInput, options: { edit?: boolean } = {}): string | null => {
    const id = crypto.randomUUID();
    let placed = false;
    change((latest) => {
      const holder = isDesignContainer(input.kind)
        ? undefined
        : containerAt(latest, latest.activePageId, {
            x: input.x ?? 0,
            y: input.y ?? 0,
            w: input.w,
            h: input.h,
          });
      const result = placeFrame(latest, { ...input, ...(holder ? { groupId: holder.id } : {}) }, { x: 0, y: 0, w: 0, h: 0 }, () => id);
      if ("error" in result) return latest;
      placed = true;
      return result.doc;
    });
    if (!placed) {
      toast.error("This page is full. Remove something to draw more.");
      return null;
    }
    setSelection(new Set([id]));
    if (options.edit) setEditing(id);
    return id;
  };

  const attachAt = React.useCallback((point: DesignPoint, except?: string) => {
    const current = latestDoc.current;
    return attachTargetAt(current, current.activePageId, point, new Set(except ? [except] : []))?.id;
  }, []);

  const moveEnd = React.useCallback(
    (id: string, index: 0 | 1, point: DesignPoint) =>
      change((current) => {
        const frame = current.frames.find((entry) => entry.id === id);
        if (!frame?.ends) return current;
        const other = frame.ends[index === 0 ? 1 : 0];
        const target = attachTargetAt(current, frame.pageId, point, new Set([id]))?.id;
        // An end dropped on the frame the other end is on stays free, so the line never loops.
        const end: DesignConnectorEnd = {
          x: Math.round(point.x),
          y: Math.round(point.y),
          ...(target && target !== other.frameId ? { frameId: target } : {}),
        };
        const ends: [DesignConnectorEnd, DesignConnectorEnd] = index === 0 ? [end, other] : [other, end];
        const frames = current.frames.map((entry) => (entry.id === id ? { ...entry, ends } : entry));
        return syncConnectors({ ...current, frames });
      }),
    [change],
  );

  const drawing = useDesignDrawing({
    tool: drawTool,
    onDone: () => setDrawTool(null),
    flow,
    wrapper,
    create: createDrawn,
    attachAt,
  });

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
    if (presentation) {
      const key = presentationKey(event);
      if (key === "exit") stopPresenting();
      else if (key !== null) step(key);
      // While presenting, the canvas's own keys (tools, zoom) do nothing.
      return true;
    }
    const command = resolveDesignCanvasKey(event, {
      editable: context.editable,
      platform: isMacPlatform() ? "darwin" : "other",
    });
    if (!command) return false;
    switch (command.type) {
      case "undo":
        if (!textEdits.undo()) undo();
        return true;
      case "redo":
        if (!textEdits.redo()) redo();
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
      case "delete": {
        if (selection.size === 0) return false;
        removeFrames([...selection]);
        // The focused frame is going; keys stay with the canvas, so ⌘Z can bring it back.
        const region = wrapper.current?.querySelector<HTMLElement>(".studio-canvas");
        requestAnimationFrame(() => {
          if (region && !region.contains(document.activeElement)) region.focus({ preventScroll: true });
        });
        return true;
      }
      case "fitSelection":
        void flow.current?.fitView({
          duration: 0,
          padding: 0.2,
          ...(selection.size > 0 ? { nodes: [...selection].map((id) => ({ id })) } : {}),
        });
        return true;
      case "enter": {
        if (drawing.finish()) return true;
        // Enter does what a double-click does: a selected page or artifact takes input,
        // and text, a shape's label or a note takes typing.
        if (selection.size !== 1) return false;
        const [id] = selection;
        const frame = doc.frames.find((entry) => entry.id === id);
        if (frame?.kind === "text" || frame?.kind === "shape") {
          setEditing(frame.id);
          return true;
        }
        if (frame?.kind === "note") {
          setAutoFocusId(frame.id);
          return true;
        }
        if (!frame || (frame.kind !== "file" && frame.kind !== "artifact")) return false;
        if (frame.kind === "file" && missing.get(frame.id) === frameVersionOf(frame)) return false;
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
      case "panel":
        setPanel((current) => ({ ...current, open: !current.open }));
        return true;
      case "draw":
        chooseDrawTool(command.tool);
        return true;
      case "escape":
        if (comments.escape()) return true;
        if (drawing.finish()) return true;
        if (drawTool !== null) setDrawTool(null);
        else if (entered !== null) setEntered(null);
        else if (selection.size > 0) setSelection(new Set());
        else return false;
        return true;
      default:
        // The shared canvas keys (tools, zoom, minimap) are the canvas's own.
        return false;
    }
  };

  // The side panel's edits go through the same paths as a drag on the canvas,
  // so a moved artboard carries its items and arrows follow what they join.
  const moveTo = React.useCallback(
    (id: string, x: number, y: number) =>
      change((current) => applyNodeChanges(current, [{ type: "position", id, position: { x, y } }])),
    [change],
  );
  const resizeTo = React.useCallback(
    (id: string, w: number, h: number) =>
      change((current) =>
        applyNodeChanges(current, [{ type: "dimensions", id, dimensions: { width: w, height: h }, setAttributes: true }]),
      ),
    [change],
  );
  const reorder = React.useCallback(
    (id: string, targetId: string, place: DesignLayerPlace) =>
      change((current) => reorderLayer(current, id, targetId, place)),
    [change],
  );
  const stepOrder = React.useCallback(
    (id: string, direction: "forward" | "backward") => change((current) => stepLayer(current, id, direction)),
    [change],
  );

  const readSource = React.useCallback(
    // A frame added a moment ago is not saved yet, and main reads the saved canvas;
    // while it can't be saved, main's copy is older than the screen, so it isn't asked.
    async (frameId: string): Promise<DesignFrameSourceResult> => {
      const saved = await flush().catch(() => false);
      if (!saved) return { error: "unsaved" };
      return designCanvasApi.designFrameSource(chatId, frameId);
    },
    [chatId, flush],
  );

  const download = React.useCallback(
    (id: string, format: DesignExportFormat) => {
      // Main exports what is saved, so a frame added a moment ago is saved first.
      void (async () => {
        const saved = await flush().catch(() => false);
        if (!saved) {
          toast.error(EXPORT_ERRORS.unsaved);
          return;
        }
        const result = await designCanvasApi
          .exportDesignFrame(chatId, id, format, readDesignArtifactTheme(true))
          .catch(() => ({ error: "failed" as const }));
        if ("saved" in result) toast.success(format === "source" ? "Saved the original file." : `Saved the ${format.toUpperCase()}.`);
        else if ("error" in result) toast.error(EXPORT_ERRORS[result.error]);
      })();
    },
    [chatId, flush],
  );

  /**
   * Present: the canvas fills the window and walks through the page's frames
   * in reading order. With `single`, it shows just one frame (Open full
   * window), which takes input like an entered frame.
   */
  function present(fromId: string | null, options: { single?: boolean } = {}) {
    const current = latestDoc.current;
    const ids = options.single && fromId ? [fromId] : presentationOrder(framesOnPage(current));
    if (ids.length === 0) {
      toast("There's nothing on this page to present yet.");
      return;
    }
    const index = Math.max(0, fromId ? ids.indexOf(fromId) : 0);
    comments.setActive(false);
    setDrawTool(null);
    setEditing(null);
    setRenaming(null);
    setSelection((selected) => (selected.size === 0 ? selected : new Set()));
    const frame = current.frames.find((entry) => entry.id === ids[index]);
    setEntered(options.single && (frame?.kind === "file" || frame?.kind === "artifact") ? frame.id : null);
    setPresentation({ ids, index, single: options.single === true, restore: latestViewport.current });
  }

  const presentRef = React.useRef(present);
  presentRef.current = present;

  function step(to: "next" | "previous" | "first" | "last") {
    setPresentation((current) => {
      if (!current) return current;
      const last = current.ids.length - 1;
      const index =
        to === "first" ? 0 : to === "last" ? last : Math.min(last, Math.max(0, current.index + (to === "next" ? 1 : -1)));
      return index === current.index ? current : { ...current, index };
    });
  }

  function stopPresenting() {
    const current = presentation;
    if (!current) return;
    setPresentation(null);
    setEntered(null);
    latestViewport.current = current.restore;
    setViewport(current.restore);
    void flow.current?.setViewport(current.restore, { duration: 0 });
    requestAnimationFrame(() =>
      wrapper.current?.querySelector<HTMLElement>(".studio-canvas")?.focus({ preventScroll: true }),
    );
  }

  // Each step fits its frame to the window, once the window-filling layout has been measured.
  const presentedId = presentation ? presentation.ids[presentation.index] : null;
  // Fitting the view is not enough on its own: a neighbour close by would still show.
  const shownNodes = React.useMemo(() => {
    if (!presentedId) return nodes;
    const shown = presentedFrameIds(doc, presentedId);
    return nodes.filter((node) => shown.has(node.id));
  }, [nodes, doc, presentedId]);
  React.useEffect(() => {
    if (!presentedId || viewSize.w === 0) return;
    const frame = requestAnimationFrame(() => {
      const instance = flow.current;
      if (!instance) return;
      // Set straight away rather than through fitView, which waits for the next
      // node update and could land after Exit has put the canvas back.
      const bounds = { ...instance.getNodesBounds([presentedId]) };
      // A page, artifact or image is shown without its title row (design-canvas.css).
      const kind = latestDoc.current.frames.find((frame) => frame.id === presentedId)?.kind;
      if ((kind === "file" || kind === "artifact" || kind === "image") && bounds.height > DESIGN_FRAME_HEADER_PX) {
        bounds.y += DESIGN_FRAME_HEADER_PX;
        bounds.height -= DESIGN_FRAME_HEADER_PX;
      }
      if (bounds.width > 0 && bounds.height > 0) {
        const fitted = getViewportForBounds(bounds, viewSize.w, viewSize.h, CANVAS_MIN_ZOOM, 4, 0.06);
        void instance.setViewport(fitted, { duration: prefersReducedMotion() ? 0 : 350 });
      }
      wrapper.current?.querySelector<HTMLElement>(".studio-canvas")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [presentedId, viewSize]);
  // A frame that goes away (Aiden removed it, say) ends a presentation that is only it.
  React.useEffect(() => {
    if (presentation && presentation.ids.every((id) => !doc.frames.some((frame) => frame.id === id))) stopPresenting();
  });

  const update = React.useCallback<DesignNodeContextValue["update"]>(
    (id, patch, { record }) =>
      change(
        (current) => {
          let changed = false;
          const frames = current.frames.map((frame): DesignFrame => {
            if (frame.id !== id) return frame;
            const keys = Object.keys(patch) as (keyof typeof patch)[];
            if (keys.every((key) => frame[key] === patch[key])) return frame;
            changed = true;
            const next: Record<string, unknown> = { ...frame };
            for (const key of keys) {
              if (patch[key] === undefined) delete next[key];
              else next[key] = patch[key];
            }
            return next as DesignFrame;
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
      frameVersionOf,
      autoFocusId,
      enter: setEntered,
      markMissing: (id, version) =>
        setMissing((current) => (current.get(id) === version ? current : new Map(current).set(id, version))),
      remove: (id) => removeFrames([id]),
      update,
      autoFocusDone: (id) => setAutoFocusId((current) => (current === id ? null : current)),
      renaming,
      rename: setRenaming,
      moveEnd,
      editing,
      edit: setEditing,
      comment: comments.commentOn,
      openFullWindow: (id) => presentRef.current(id, { single: true }),
      download,
      pageEditing: textEdits.editing,
      onPageEdit: textEdits.onMessage,
      pageEditCommand: textEdits.command,
      pageEditFinish: textEdits.finish,
      pageEditComment: () => {
        const current = textEdits.editing;
        if (!current) return;
        textEdits.finish(false);
        comments.commentOnElement(current.frameId, current.element);
      },
    }),
    [
      chatId,
      grant,
      live,
      entered,
      versionOf,
      frameVersionOf,
      autoFocusId,
      removeFrames,
      update,
      renaming,
      moveEnd,
      editing,
      comments.commentOn,
      comments.commentOnElement,
      download,
      textEdits.editing,
      textEdits.onMessage,
      textEdits.command,
      textEdits.finish,
    ],
  );

  return (
    <div className="flex h-full w-full">
      {/* Its letter, digit and +/- keys are the canvas's own, so the chat's composer leaves them alone. */}
      <div
        ref={wrapper}
        data-typing-surface="canvas"
        data-presenting={presentation ? (presentation.single ? "frame" : "page") : undefined}
        className={
          presentation
            ? "design-presenting fixed inset-0 z-[70] bg-background"
            : comments.active
              ? "design-commenting h-full min-w-0 flex-1"
              : drawTool
                ? "design-drawing h-full min-w-0 flex-1"
                : "h-full min-w-0 flex-1"
        }
        data-draw-tool={drawTool ?? undefined}
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
            nodes={shownNodes}
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
              // Present moves the view for itself; the page keeps where the person left it.
              if (presentingRef.current) return;
              change((current) => withActiveViewport(current, { x: next.x, y: next.y, zoom: next.zoom }), {
                record: false,
              });
            }}
            onPaneClick={(event) => {
              if (presentation) return;
              if (comments.onPaneClick(event)) return;
              setEntered(null);
            }}
            onNodeClick={(event, node) => {
              comments.onNodeClick(event, node);
            }}
            onNodeMouseMove={comments.onNodeMouseMove}
            onNodeMouseLeave={comments.onNodeMouseLeave}
            nodesDraggable={!comments.active && drawTool === null}
            elementsSelectable={!comments.active && drawTool === null}
            deleteKeyCode={null}
            elevateNodesOnSelect={false}
            zoomOnDoubleClick={false}
            resolveKey={resolveKey}
            presenting={presentation !== null}
            actions={
              <>
                <DesignPresentButton onPresent={() => present(null)} />
                <DesignPanelButton
                  open={panel.open}
                  onToggle={() => setPanel((current) => ({ ...current, open: !current.open }))}
                />
              </>
            }
            overlay={
              presentation ? (
                <DesignPresentBar
                  presentation={presentation}
                  title={doc.frames.find((frame) => frame.id === presentation.ids[presentation.index])?.title ?? ""}
                  onStep={step}
                  onExit={stopPresenting}
                />
              ) : null
            }
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
                drawTool={drawTool}
                onDraw={chooseDrawTool}
              />
            }
          >
            {presentation ? null : comments.layer}
            {presentation ? null : drawing.layer}
          </StudioCanvas>
        </DesignNodeContext.Provider>
      </div>
      {panel.open && !presentation ? (
        <DesignSidePanel
          readSource={readSource}
          doc={doc}
          selection={selection}
          tab={panel.tab}
          onTab={(tab) => setPanel((current) => ({ ...current, tab }))}
          onClose={() => {
            setPanel((current) => ({ ...current, open: false }));
            wrapper.current?.querySelector<HTMLElement>(".studio-canvas")?.focus({ preventScroll: true });
          }}
          versionOf={versionOf}
          onSelect={(ids) => setSelection(new Set(ids))}
          update={update}
          moveTo={moveTo}
          resizeTo={resizeTo}
          reorder={reorder}
          step={stepOrder}
        />
      ) : null}
    </div>
  );
}

const PANEL_STORAGE_KEY = "aiden.design.sidePanel";

/** Whether the side panel was open, and on which tab, the last time on this device. */
function readPanelState(): { open: boolean; tab: DesignPanelTab } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PANEL_STORAGE_KEY) ?? "null") as unknown;
    if (saved && typeof saved === "object") {
      const { open, tab } = saved as { open?: unknown; tab?: unknown };
      return { open: open === true, tab: DESIGN_PANEL_TABS.includes(tab as DesignPanelTab) ? (tab as DesignPanelTab) : "properties" };
    }
  } catch {
    // Storage that cannot be read starts the panel closed.
  }
  return { open: false, tab: "properties" };
}

function writePanelState(state: { open: boolean; tab: DesignPanelTab }): void {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not remembered; it still works for this session.
  }
}
