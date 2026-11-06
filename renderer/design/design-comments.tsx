// Comments on the design canvas: the comment tool (C), picking an element on
// a live page through its bridge, pins that follow their frame or element,
// the comment box, and the tray that hands queued comments to the composer.
//
// The canvas owns the document; this hook keeps only what lives on screen:
// the draft being written, the comment that is open, how far each live page
// is scrolled, and which bridge requests are on their way.

import { useReactFlow, useStore, ViewportPortal, type Node, type ReactFlowInstance } from "@xyflow/react";
import { Check, Eraser, Mic, PenLine, Trash2, X } from "lucide-react";
import * as React from "react";
import { Button, Textarea, toast } from "../components/ui";
import { Checkbox } from "../components/ui-primitives";
import { designCanvasApi } from "../lib/ipc";
import { useSettings } from "../lib/queries";
import { cn } from "../lib/ui-utils";
import { useVoiceRecorder } from "../lib/use-voice-recorder";
import { parseDesignBridgeMessage, postToDesignPage, type DesignBridgeMessage } from "../shared/design-canvas/bridge-messages";
import {
  addComment,
  applyAnchorReport,
  commentLabel,
  deleteComment,
  designCommentsBlock,
  editComment,
  elementLabel,
  locateAnchor,
  markCommentsSent,
  queuedComments,
  reopenComment,
  resolveComment,
  setCommentQueued,
  type DesignCommentPlace,
  type DesignLocated,
} from "../shared/design-canvas/comments";
import { showPage } from "../shared/design-canvas/pages";
import type { DesignCanvas, DesignComment, DesignCommentAnchor, DesignFrame } from "../shared/design-canvas/schema";
import type { DesignNode } from "./canvas-adapter-core";
import { commentNumbers, marksFromCanvas, marksOnCanvas, pinPlace, type FrameScroll } from "./comment-geometry";
import { forgetCommentCrops, publishDesignCommentTray, rememberCommentCrop } from "./comment-tray-store";
import { DESIGN_DEFAULT_WIDTH } from "./nodes/design-node-context";

/** How long a page has to answer a pick. */
const PICK_TIMEOUT_MS = 1500;
/** The picture taken of a commented spot, in screen pixels, before it is fitted to the canvas. */
const CROP_SIZE = { w: 520, h: 360 } as const;

type Mutation = (doc: DesignCanvas) => DesignCanvas;
type Stroke = [number, number][];
type Picked = Extract<DesignBridgeMessage, { type: "picked" }>;

export type CommentDraft = {
  id: string;
  place: DesignCommentPlace;
  label: string;
};

type CommentsInput = {
  chatId: string;
  doc: DesignCanvas;
  change(mutate: Mutation, options?: { record?: boolean }): void;
  flow: React.RefObject<ReactFlowInstance<DesignNode> | null>;
  wrapper: React.RefObject<HTMLDivElement | null>;
  live: ReadonlySet<string>;
  versionOf(path: string | undefined): number;
};

/** Where a pin goes: a saved comment, or a draft's place. */
type PinSource = Pick<DesignComment, "frameId" | "x" | "y"> & { anchor?: Omit<DesignCommentAnchor, "commentId"> };

/** A stand-in comment for placing a pin that is not saved yet. */
function asPinComment(id: string, source: PinSource): DesignComment {
  const comment: DesignComment = { id, pageId: "", x: source.x, y: source.y, note: "", state: "open", anchorState: "anchored", createdAt: "" };
  if (source.frameId !== undefined) comment.frameId = source.frameId;
  if (source.anchor) comment.anchor = { ...source.anchor, commentId: id };
  return comment;
}

function frameIframe(wrapper: HTMLElement | null, frameId: string): HTMLIFrameElement | null {
  if (!wrapper) return null;
  for (const iframe of wrapper.querySelectorAll<HTMLIFrameElement>("iframe[data-frame-id]")) {
    if (iframe.getAttribute("data-frame-id") === frameId) return iframe;
  }
  return null;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function useDesignComments({ chatId, doc, change, flow, wrapper, live, versionOf }: CommentsInput) {
  const [active, setActiveState] = React.useState(false);
  const [draft, setDraft] = React.useState<CommentDraft | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [scroll, setScroll] = React.useState<ReadonlyMap<string, FrameScroll>>(() => new Map());
  const [capturing, setCapturing] = React.useState(false);
  const [pendingOpen, setPendingOpen] = React.useState<string | null>(null);
  /** Marks being drawn for the open box, in canvas units. */
  const [strokes, setStrokes] = React.useState<Stroke[]>([]);
  const [drawing, setDrawing] = React.useState(false);

  const docRef = React.useRef(doc);
  const versionOfRef = React.useRef(versionOf);
  React.useLayoutEffect(() => {
    docRef.current = doc;
    versionOfRef.current = versionOf;
  }, [doc, versionOf]);
  const picks = React.useRef(new Map<string, (picked: Picked | null) => void>());
  const locates = React.useRef(new Map<string, { frameId: string; version: number }>());
  /** The file version each comment was sent at; a newer version that still finds its element resolves it. */
  const sentVersions = React.useRef(new Map<string, number>());
  const hovered = React.useRef<string | null>(null);
  const draftNote = React.useRef("");

  const pageWindow = React.useCallback(
    (frameId: string) => frameIframe(wrapper.current, frameId)?.contentWindow ?? null,
    [wrapper],
  );

  const clearHover = React.useCallback(() => {
    if (hovered.current === null) return;
    postToDesignPage(pageWindow(hovered.current), { type: "hover-at", clear: true });
    hovered.current = null;
  }, [pageWindow]);

  const setActive = React.useCallback(
    (next: boolean) => {
      setActiveState(next);
      if (!next) {
        setDraft(null);
        clearHover();
      }
    },
    [clearHover],
  );

  // Asks a page where its comments' elements are now.
  const locate = React.useCallback(
    (frameId: string) => {
      const current = docRef.current;
      const frame = current.frames.find((entry) => entry.id === frameId);
      const items = current.comments
        .filter((comment) => comment.frameId === frameId && comment.anchor)
        .map((comment) => ({
          commentId: comment.id,
          selector: comment.anchor!.selector,
          text: comment.anchor!.text,
          tag: comment.anchor!.tag,
        }));
      if (!frame || items.length === 0) return;
      const requestId = crypto.randomUUID();
      locates.current.set(requestId, { frameId, version: versionOfRef.current(frame.path) });
      postToDesignPage(pageWindow(frameId), { type: "locate", requestId, items });
    },
    [pageWindow],
  );

  React.useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!event.source) return;
      let frameId: string | null = null;
      for (const iframe of wrapper.current?.querySelectorAll<HTMLIFrameElement>("iframe[data-frame-id]") ?? []) {
        if (iframe.contentWindow && iframe.contentWindow === event.source) frameId = iframe.getAttribute("data-frame-id");
      }
      if (!frameId) return;
      const message = parseDesignBridgeMessage(event.data);
      if (!message) return;
      if (message.type === "ready") {
        setScroll((current) => (current.has(frameId) ? new Map(current).set(frameId, { x: 0, y: 0 }) : current));
        locate(frameId);
      } else if (message.type === "scroll") {
        setScroll((current) => new Map(current).set(frameId, { x: message.x, y: message.y }));
      } else if (message.type === "picked") {
        const settle = picks.current.get(message.requestId);
        picks.current.delete(message.requestId);
        settle?.(message);
      } else if (message.type === "anchors") {
        const request = locates.current.get(message.requestId);
        if (!request || request.frameId !== frameId) return;
        locates.current.delete(message.requestId);
        const current = docRef.current;
        const plain: Record<string, DesignLocated> = {};
        const resolving: Record<string, DesignLocated> = {};
        for (const comment of current.comments) {
          const result = message.results[comment.id];
          if (comment.frameId !== frameId || !comment.anchor || !result) continue;
          const located = locateAnchor(comment.anchor, result);
          const sentAt = sentVersions.current.get(comment.id);
          const changedSince = comment.state === "sent" && sentAt !== undefined && request.version > sentAt;
          (changedSince ? resolving : plain)[comment.id] = located;
        }
        const at = new Date().toISOString();
        change(
          (latest) =>
            applyAnchorReport(applyAnchorReport(latest, frameId, plain), frameId, resolving, { resolveSent: true, at }),
          { record: false },
        );
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [wrapper, locate, change]);

  /** What a live page has under a screen point, or null when it does not answer. */
  const pickAt = React.useCallback(
    (frame: DesignFrame, clientX: number, clientY: number, wide: boolean): Promise<Picked | null> => {
      const iframe = frameIframe(wrapper.current, frame.id);
      const target = iframe?.contentWindow;
      const rect = iframe?.getBoundingClientRect();
      if (!target || !rect || rect.width <= 0) return Promise.resolve(null);
      const factor = (frame.designWidth ?? DESIGN_DEFAULT_WIDTH) / rect.width;
      const x = (clientX - rect.left) * factor;
      const y = (clientY - rect.top) * factor;
      if (x < 0 || y < 0 || x > rect.width * factor || y > rect.height * factor) return Promise.resolve(null);
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          picks.current.delete(requestId);
          resolve(null);
        }, PICK_TIMEOUT_MS);
        picks.current.set(requestId, (picked) => {
          clearTimeout(timer);
          resolve(picked);
        });
        postToDesignPage(target, { type: "pick-at", requestId, x, y, wide });
      });
    },
    [wrapper],
  );

  const startDraft = (next: CommentDraft) => {
    draftNote.current = "";
    setOpenId(null);
    setStrokes([]);
    setDrawing(false);
    setDraft(next);
  };

  // An open comment shows its marks, ready to be added to.
  const openComment = (id: string | null) => {
    setDrawing(false);
    const comment = id ? docRef.current.comments.find((entry) => entry.id === id) : undefined;
    const frame = comment?.frameId ? docRef.current.frames.find((entry) => entry.id === comment.frameId) : undefined;
    setStrokes(comment ? marksOnCanvas(frame, comment.marks) : []);
    setOpenId(id);
  };

  const outsideClick = (): boolean => {
    if (draft) {
      // A draft with words in it stays open; an empty one goes.
      if (!draftNote.current.trim()) setDraft(null);
      return true;
    }
    if (openId !== null) {
      openComment(null);
      return true;
    }
    return false;
  };

  const onPaneClick = (event: React.MouseEvent): boolean => {
    if (outsideClick() || !active) return active;
    const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!point) return true;
    startDraft({ id: crypto.randomUUID(), place: { x: point.x, y: point.y }, label: "Canvas" });
    return true;
  };

  const onNodeClick = (event: React.MouseEvent, node: Node): boolean => {
    if (!active) return false;
    if (outsideClick()) return true;
    const frame = (node as DesignNode).data.frame;
    const point = flow.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (!frame || !point) return true;
    const x = point.x - frame.x;
    const y = point.y - frame.y;
    const { clientX, clientY, altKey } = event;
    if (frame.kind === "file" && live.has(frame.id)) {
      void pickAt(frame, clientX, clientY, altKey).then((picked) => {
        if (picked?.element) {
          const { selector, text, tag, rect, sourcePath } = picked.element;
          startDraft({
            id: crypto.randomUUID(),
            place: {
              frameId: frame.id,
              x,
              y,
              anchor: { selector, text, tag, rect, point: picked.point, ...(sourcePath ? { sourcePath } : {}) },
            },
            label: `${frame.title} › ${elementLabel(picked.element)}`,
          });
        } else {
          startDraft({ id: crypto.randomUUID(), place: { frameId: frame.id, x, y }, label: frame.title });
        }
      });
      return true;
    }
    startDraft({ id: crypto.randomUUID(), place: { frameId: frame.id, x, y }, label: frame.title });
    return true;
  };

  const hoverFrame = React.useRef<number | null>(null);
  const onNodeMouseMove = (event: React.MouseEvent, node: Node) => {
    if (!active || draft) return;
    const frame = (node as DesignNode).data.frame;
    if (!frame || frame.kind !== "file" || !live.has(frame.id)) {
      clearHover();
      return;
    }
    const { clientX, clientY, altKey } = event;
    if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = null;
      const iframe = frameIframe(wrapper.current, frame.id);
      const rect = iframe?.getBoundingClientRect();
      if (!iframe || !rect || rect.width <= 0) return;
      if (hovered.current !== null && hovered.current !== frame.id) clearHover();
      hovered.current = frame.id;
      const factor = (frame.designWidth ?? DESIGN_DEFAULT_WIDTH) / rect.width;
      postToDesignPage(iframe.contentWindow, {
        type: "hover-at",
        x: (clientX - rect.left) * factor,
        y: (clientY - rect.top) * factor,
        wide: altKey,
      });
    });
  };
  React.useEffect(
    () => () => {
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );

  const open = React.useCallback(
    (id: string) => {
      const comment = docRef.current.comments.find((entry) => entry.id === id);
      if (!comment) return;
      setDraft(null);
      if (docRef.current.activePageId !== comment.pageId) {
        change((current) => showPage(current, comment.pageId), { record: false });
      }
      setPendingOpen(id);
    },
    [change],
  );
  // Once the comment's page is on screen, bring its pin into view and open it.
  React.useEffect(() => {
    if (pendingOpen === null) return;
    const comment = doc.comments.find((entry) => entry.id === pendingOpen);
    if (!comment) {
      setPendingOpen(null);
      return;
    }
    if (doc.activePageId !== comment.pageId) return;
    // The page switch moves the view on its own render; centre on the pin after it.
    const timer = setTimeout(() => {
      setPendingOpen(null);
      const place = pinPlace(doc, comment, scroll);
      const zoom = Math.max(flow.current?.getZoom() ?? 1, 0.5);
      void flow.current?.setCenter(place.x + 160, place.y, { zoom, duration: 0 });
      openComment(comment.id);
    }, 0);
    return () => clearTimeout(timer);
  }, [pendingOpen, doc, scroll, flow]);

  // The element a box is open on is outlined inside its page.
  const highlighted = draft?.place.frameId
    ? { frameId: draft.place.frameId, commentId: draft.id, selector: draft.place.anchor?.selector }
    : (() => {
        const comment = openId ? doc.comments.find((entry) => entry.id === openId) : undefined;
        return comment?.frameId && comment.anchor
          ? { frameId: comment.frameId, commentId: comment.id, selector: comment.anchor.selector }
          : null;
      })();
  const highlightKey = highlighted && live.has(highlighted.frameId) ? `${highlighted.frameId}\n${highlighted.commentId}\n${highlighted.selector ?? ""}` : "";
  React.useEffect(() => {
    if (!highlightKey) return;
    const [frameId, commentId, selector] = highlightKey.split("\n") as [string, string, string];
    const target = pageWindow(frameId);
    postToDesignPage(target, { type: "highlight", commentId, ...(selector ? { selector } : {}) });
    return () => postToDesignPage(target, { type: "highlight", clear: true });
  }, [highlightKey, pageWindow]);

  /** Takes a picture of the spot a comment is about, with its box out of the way. */
  const captureSpot = async (commentId: string, comment: PinSource) => {
    const region = wrapper.current?.getBoundingClientRect();
    const instance = flow.current;
    if (!region || !instance || region.width < 1 || region.height < 1 || document.visibilityState === "hidden") return;
    setCapturing(true);
    try {
      await nextFrame();
      await nextFrame();
      const place = pinPlace(docRef.current, asPinComment(commentId, comment), scroll);
      const pin = instance.flowToScreenPosition({ x: place.x, y: place.y });
      const w = Math.min(CROP_SIZE.w, region.width);
      const h = Math.min(CROP_SIZE.h, region.height);
      const x = Math.min(Math.max(pin.x - w / 2, region.left), region.right - w);
      const y = Math.min(Math.max(pin.y - h / 2, region.top), region.bottom - h);
      const shot = await designCanvasApi.captureDesignFrame({ x, y, width: w, height: h });
      if ("dataUrl" in shot) rememberCommentCrop(chatId, commentId, shot.dataUrl);
    } catch {
      // A missing picture leaves the words to speak for the spot.
    } finally {
      setCapturing(false);
    }
  };

  const saveDraft = async (note: string, queued: boolean) => {
    if (!draft) return;
    const current = draft;
    const createdAt = new Date().toISOString();
    let added = true;
    const frame = current.place.frameId ? docRef.current.frames.find((entry) => entry.id === current.place.frameId) : undefined;
    const marks = marksFromCanvas(frame, strokes);
    setDrawing(false);
    change((latest) => {
      const next = addComment(latest, { id: current.id, place: current.place, note, createdAt, queued, marks });
      if (!next) {
        added = false;
        return latest;
      }
      return next;
    });
    if (!added) {
      toast.error("This canvas has too many comments. Delete some to add another.");
      return;
    }
    setDraft(null);
    await captureSpot(current.id, current.place);
  };

  const saveComment = async (id: string, note: string, queued: boolean) => {
    const comment = docRef.current.comments.find((entry) => entry.id === id);
    const frame = comment?.frameId ? docRef.current.frames.find((entry) => entry.id === comment.frameId) : undefined;
    const marks = marksFromCanvas(frame, strokes);
    setDrawing(false);
    change((latest) => setCommentQueued(editComment(latest, id, { note, marks }), id, queued));
    // The picture is taken with the marks still on screen and the box hidden.
    if (comment && queued) await captureSpot(id, comment);
    openComment(null);
  };

  const removeComment = (id: string) => {
    change((latest) => deleteComment(latest, id));
    forgetCommentCrops(chatId, [id]);
    openComment(null);
  };

  const escape = (): boolean => {
    if (drawing) setDrawing(false);
    else if (draft) setDraft(null);
    else if (openId !== null) openComment(null);
    else if (active) setActive(false);
    else return false;
    return true;
  };

  // The tray: queued comments for the composer to send.
  const openRef = React.useRef(open);
  React.useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);
  React.useEffect(() => {
    const queued = queuedComments(doc);
    publishDesignCommentTray(
      chatId,
      queued.length === 0
        ? null
        : {
            comments: queued.map((comment) => ({ id: comment.id, label: commentLabel(doc, comment), note: comment.note })),
            block: designCommentsBlock(doc, queued),
            remove: (id) => change((latest) => setCommentQueued(latest, id, false)),
            markSent: (ids) => {
              for (const id of ids) {
                const comment = docRef.current.comments.find((entry) => entry.id === id);
                const frame = comment?.frameId ? docRef.current.frames.find((entry) => entry.id === comment.frameId) : undefined;
                sentVersions.current.set(id, versionOfRef.current(frame?.path));
              }
              change((latest) => markCommentsSent(latest, ids, new Date().toISOString()));
              forgetCommentCrops(chatId, ids);
            },
            open: (id) => openRef.current(id),
          },
    );
  }, [chatId, doc, change]);
  React.useEffect(() => () => publishDesignCommentTray(chatId, null), [chatId]);

  const layer = (
    <CommentLayer
      doc={doc}
      scroll={scroll}
      draft={draft}
      openId={openId}
      capturing={capturing}
      strokes={strokes}
      drawing={drawing}
      onDraw={setDrawing}
      onStrokes={setStrokes}
      onOpen={(id) => {
        setDraft(null);
        openComment(openId === id ? null : id);
      }}
      onClose={() => {
        setDraft(null);
        openComment(null);
      }}
      onDraftNote={(note) => {
        draftNote.current = note;
      }}
      onSaveDraft={(note, queued) => void saveDraft(note, queued)}
      onSave={(id, note, queued) => void saveComment(id, note, queued)}
      onDelete={removeComment}
      onResolve={(id) => {
        change((latest) => resolveComment(latest, id, new Date().toISOString()));
        openComment(null);
      }}
      onReopen={(id) => change((latest) => reopenComment(latest, id))}
    />
  );

  return {
    active,
    setActive,
    onPaneClick,
    onNodeClick,
    onNodeMouseMove,
    onNodeMouseLeave: clearHover,
    escape,
    open,
    layer,
  };
}

type LayerProps = {
  doc: DesignCanvas;
  scroll: ReadonlyMap<string, FrameScroll>;
  draft: CommentDraft | null;
  openId: string | null;
  capturing: boolean;
  strokes: Stroke[];
  drawing: boolean;
  onDraw(drawing: boolean): void;
  onStrokes(strokes: Stroke[]): void;
  onOpen(id: string): void;
  onClose(): void;
  onDraftNote(note: string): void;
  onSaveDraft(note: string, queued: boolean): void;
  onSave(id: string, note: string, queued: boolean): void;
  onDelete(id: string): void;
  onResolve(id: string): void;
  onReopen(id: string): void;
};

/** Pins and the open comment box, drawn in canvas space above the frames. */
function CommentLayer({ doc, scroll, draft, openId, capturing, strokes, drawing, onDraw, onStrokes, ...actions }: LayerProps) {
  const zoom = useStore((state) => state.transform[2]) || 1;
  const numbers = React.useMemo(() => commentNumbers(doc), [doc]);
  const comments = doc.comments.filter(
    (comment) => comment.pageId === doc.activePageId && (comment.state !== "resolved" || comment.id === openId),
  );
  const open = openId ? comments.find((comment) => comment.id === openId) : undefined;
  const draftPlace = draft
    ? pinPlace(doc, asPinComment(draft.id, draft.place), scroll)
    : null;
  const at = (x: number, y: number): React.CSSProperties => ({
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "0 0",
    transform: `translate(${x}px, ${y}px) scale(${1 / zoom})`,
  });

  const pen = { drawing, hasMarks: strokes.length > 0, onDraw, onClear: () => onStrokes([]) };
  // Saved marks of the other comments on the page, drawn faintly.
  const others = comments.flatMap((comment) => {
    if (comment.id === openId || !comment.marks || comment.state === "resolved") return [];
    const frame = comment.frameId ? doc.frames.find((entry) => entry.id === comment.frameId) : undefined;
    return marksOnCanvas(frame, comment.marks).map((stroke, index) => ({ key: `${comment.id}-${index}`, stroke }));
  });

  return (
    <ViewportPortal>
      <div data-design-comments="" className="contents">
        <svg aria-hidden className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
          {others.map(({ key, stroke }) => (
            <polyline key={key} points={stroke.map(([x, y]) => `${x},${y}`).join(" ")} className="design-mark design-mark-quiet" />
          ))}
          {(draft || openId) && strokes.map((stroke, index) => (
            <polyline key={index} points={stroke.map(([x, y]) => `${x},${y}`).join(" ")} className="design-mark" />
          ))}
        </svg>
        {drawing ? <DrawSurface strokes={strokes} onStrokes={onStrokes} /> : null}
        {comments.map((comment) => {
          const place = pinPlace(doc, comment, scroll);
          if (place.hidden && comment.id !== openId) return null;
          return (
            <div key={comment.id} style={at(place.x, place.y)}>
              <CommentPin
                comment={comment}
                number={numbers.get(comment.id) ?? 0}
                open={comment.id === openId}
                label={commentLabel(doc, comment)}
                onClick={() => actions.onOpen(comment.id)}
              />
              {comment.id === open?.id ? (
                <CommentBox
                  key={comment.id}
                  label={commentLabel(doc, comment)}
                  comment={comment}
                  hidden={capturing}
                  onClose={actions.onClose}
                  pen={pen}
                  onSave={(note, queued) => actions.onSave(comment.id, note, queued)}
                  onDelete={() => actions.onDelete(comment.id)}
                  onResolve={() => actions.onResolve(comment.id)}
                  onReopen={() => actions.onReopen(comment.id)}
                />
              ) : null}
            </div>
          );
        })}
        {draft && draftPlace ? (
          <div style={at(draftPlace.x, draftPlace.y)}>
            <CommentPin number={0} open label={draft.label} />
            <CommentBox
              key={draft.id}
              label={draft.label}
              hidden={capturing}
              onClose={actions.onClose}
              pen={pen}
              onNote={actions.onDraftNote}
              onSave={actions.onSaveDraft}
            />
          </div>
        ) : null}
      </div>
    </ViewportPortal>
  );
}

/** Takes the pointer while the pen is on: each drag adds a stroke, in canvas units. */
function DrawSurface({ strokes, onStrokes }: { strokes: Stroke[]; onStrokes(strokes: Stroke[]): void }) {
  const flow = useReactFlow();
  const current = React.useRef<Stroke | null>(null);
  const base = React.useRef<Stroke[]>(strokes);
  const point = (event: React.PointerEvent): [number, number] => {
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    return [Math.round(at.x * 10) / 10, Math.round(at.y * 10) / 10];
  };
  return (
    <div
      data-design-draw=""
      aria-hidden
      className="nodrag nopan nowheel pointer-events-auto absolute cursor-crosshair touch-none"
      style={{ left: -1_000_000, top: -1_000_000, width: 2_000_000, height: 2_000_000 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        base.current = strokes;
        current.current = [point(event)];
        onStrokes([...base.current, current.current]);
      }}
      onPointerMove={(event) => {
        if (!current.current) return;
        current.current = [...current.current, point(event)];
        onStrokes([...base.current, current.current]);
      }}
      onPointerUp={() => {
        current.current = null;
      }}
      onPointerCancel={() => {
        current.current = null;
      }}
    />
  );
}

function CommentPin({
  comment,
  number,
  open,
  label,
  onClick,
}: {
  comment?: DesignComment;
  number: number;
  open: boolean;
  label: string;
  onClick?(): void;
}) {
  const state = comment?.state ?? "open";
  const lost = comment?.anchorState === "lost";
  const name = comment
    ? `Comment ${number} on ${label}${state === "sent" ? ", sent to Aiden" : state === "resolved" ? ", resolved" : ""}${lost ? ", element not found" : ""}`
    : "New comment";
  return (
    <button
      type="button"
      aria-label={name}
      aria-expanded={onClick ? open : undefined}
      title={lost ? "Element not found" : undefined}
      tabIndex={onClick ? 0 : -1}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      className={cn(
        "nodrag nopan pointer-events-auto absolute bottom-0 left-0 grid size-7 place-items-center rounded-full rounded-bl-none text-small-strong shadow-control outline-none transition-[transform,opacity] duration-(--motion-duration) ease-standard focus-visible:ring-2 focus-visible:ring-focus-ring",
        state === "open" && "bg-fill-accent text-fill-accent-foreground",
        state === "sent" && "bg-control text-primary",
        state === "resolved" && "bg-control text-tertiary",
        lost && "opacity-55",
        open && "scale-110",
      )}
    >
      {state === "resolved" ? <Check aria-hidden className="size-3.5" /> : number > 0 ? number : null}
    </button>
  );
}

function CommentBox({
  label,
  comment,
  hidden,
  onClose,
  onNote,
  onSave,
  onDelete,
  onResolve,
  onReopen,
  pen,
}: {
  label: string;
  /** Absent for a new comment. */
  comment?: DesignComment;
  hidden: boolean;
  onClose(): void;
  pen?: { drawing: boolean; hasMarks: boolean; onDraw(drawing: boolean): void; onClear(): void };
  onNote?(note: string): void;
  onSave(note: string, queued: boolean): void;
  onDelete?(): void;
  onResolve?(): void;
  onReopen?(): void;
}) {
  const [note, setNote] = React.useState(comment?.note ?? "");
  const [queued, setQueued] = React.useState(comment ? Boolean(comment.queued) : true);
  const editable = !comment || comment.state === "open";
  const input = React.useRef<HTMLTextAreaElement | null>(null);
  const update = (next: string) => {
    setNote(next);
    onNote?.(next);
  };
  const save = () => {
    const clean = note.trim();
    if (!clean) return;
    onSave(clean, queued);
  };

  return (
    <div
      role="dialog"
      aria-label={comment ? "Comment" : "New comment"}
      className={cn(
        "nodrag nopan nowheel pointer-events-auto absolute left-9 top-[-1.75rem] w-72 select-text rounded-button bg-popover p-2 text-primary shadow-composer",
        hidden && "invisible",
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1 pb-1.5 pl-1">
        <span className="min-w-0 flex-1 truncate text-small text-secondary" title={label}>
          {label}
        </span>
        {comment?.state === "sent" ? <span className="shrink-0 text-small text-secondary">Sent to Aiden</span> : null}
        {comment?.state === "resolved" ? <span className="shrink-0 text-small text-secondary">Resolved</span> : null}
        <Button variant="transparent" size="small" iconOnly aria-label="Close comment" onClick={onClose}>
          <X />
        </Button>
      </div>
      {comment?.anchorState === "lost" ? (
        <p className="px-1 pb-1.5 text-small text-status-red">Element not found</p>
      ) : null}
      {editable ? (
        <Textarea
          ref={input}
          density="compact"
          aria-label="Comment"
          placeholder="What should change?"
          value={note}
          autoFocus
          maxLength={2000}
          onChange={(event) => update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              save();
            }
          }}
          className="max-h-40"
        />
      ) : (
        <p className="whitespace-pre-wrap break-words px-1 text-regular">{comment?.note}</p>
      )}
      <div className="mt-2 flex items-center gap-1">
        {editable ? (
          <CommentMic
            onText={(heard) => {
              const next = note.trim() ? `${note.trimEnd()} ${heard}` : heard;
              update(next);
              input.current?.focus();
            }}
          />
        ) : null}
        {editable && pen ? (
          <>
            <Button
              variant={pen.drawing ? "muted" : "transparent"}
              size="small"
              iconOnly
              aria-label="Draw marks"
              aria-pressed={pen.drawing}
              title="Draw marks"
              onClick={() => pen.onDraw(!pen.drawing)}
            >
              <PenLine />
            </Button>
            {pen.hasMarks ? (
              <Button variant="transparent" size="small" iconOnly aria-label="Clear marks" title="Clear marks" onClick={pen.onClear}>
                <Eraser />
              </Button>
            ) : null}
          </>
        ) : null}
        {comment && onDelete ? (
          <Button variant="transparent" size="small" iconOnly aria-label="Delete comment" onClick={onDelete}>
            <Trash2 />
          </Button>
        ) : null}
        <div className="flex-1" />
        {editable ? (
          <>
            <Checkbox checked={queued} onCheckedChange={setQueued} label="Send to Aiden" className="mr-1" />
            <Button variant="accent" size="small" disabled={!note.trim()} onClick={save}>
              Save
            </Button>
          </>
        ) : comment?.state === "sent" ? (
          <Button variant="filled" size="small" onClick={onResolve}>
            Resolve
          </Button>
        ) : (
          <Button variant="filled" size="small" onClick={onReopen}>
            Reopen
          </Button>
        )}
      </div>
    </div>
  );
}

/** The comment box's microphone: the same voice input as the composer. */
function CommentMic({ onText }: { onText(text: string): void }) {
  const settings = useSettings();
  const voice = useVoiceRecorder((heard) => {
    if (heard.trim()) onText(heard.trim());
  }, { model: settings.data?.voiceModel });
  const busy = voice.recording || voice.transcribing;
  return (
    <Button
      variant="transparent"
      size="small"
      iconOnly
      aria-label={voice.recording ? "Stop dictating" : "Dictate"}
      aria-pressed={voice.recording}
      disabled={voice.transcribing}
      onClick={() => {
        if (voice.recording) voice.stop();
        else if (!busy) void voice.start();
      }}
    >
      <Mic className={cn(voice.recording && "animate-pulse motion-reduce:animate-none")} />
    </Button>
  );
}
