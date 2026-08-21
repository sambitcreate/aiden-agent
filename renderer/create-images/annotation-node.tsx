import * as React from "react";
import type Konva from "konva";
import { ArrowRight, Circle, MousePointer2, Pencil, Square, Trash2, Type } from "lucide-react";
import {
  Arrow,
  Ellipse,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text as KonvaText,
  Transformer,
} from "react-konva";
import {
  CREATE_IMAGES_ANNOTATION_COLORS,
  CREATE_IMAGES_MAX_ANNOTATION_SHAPES,
  type AnnotationNodeV3,
  type CreateImagesAnnotationColor,
  type CreateImagesAnnotationShape,
} from "../shared/create-images/schema";
import { useCreateImagesCanvasActions } from "./canvas-context";

const STAGE_WIDTH = 264;
const STAGE_HEIGHT = 198;
const COLOR_VALUES: Readonly<Record<CreateImagesAnnotationColor, string>> = Object.freeze({
  accent: "#1677ff",
  red: "#e5484d",
  green: "#30a46c",
  yellow: "#f5d90a",
  white: "#ffffff",
  black: "#111111",
});

type AnnotationTool = "select" | "rectangle" | "ellipse" | "arrow" | "freehand" | "text";

function usePreviewImage(
  url: string | undefined,
  onLoad: () => void,
  onError: () => void,
): HTMLImageElement | undefined {
  const [image, setImage] = React.useState<HTMLImageElement>();
  React.useEffect(() => {
    if (!url) {
      setImage(undefined);
      return;
    }
    const next = new Image();
    let active = true;
    next.onload = () => {
      if (active) {
        setImage(next);
        onLoad();
      }
    };
    next.onerror = () => {
      if (active) onError();
    };
    next.src = url;
    return () => {
      active = false;
      next.onload = null;
      next.onerror = null;
    };
  }, [onError, onLoad, url]);
  return image;
}

function nextShape(tool: Exclude<AnnotationTool, "select" | "freehand">): CreateImagesAnnotationShape {
  const id = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const common = { id, x: 0.2, y: 0.2, stroke: "accent" as const, strokeWidth: 4 };
  if (tool === "rectangle" || tool === "ellipse") {
    return { ...common, type: tool, width: 0.35, height: 0.28 };
  }
  if (tool === "arrow") return { ...common, type: "arrow", points: [0, 0, 0.35, 0.2] };
  return { ...common, type: "text", text: "Label", fontSize: 42 };
}

function updateShape(
  shapes: readonly CreateImagesAnnotationShape[],
  id: string,
  update: (shape: CreateImagesAnnotationShape) => CreateImagesAnnotationShape,
): CreateImagesAnnotationShape[] {
  return shapes.map((shape) => (shape.id === id ? update(shape) : shape));
}

export function AnnotationBody({ node }: { node: AnnotationNodeV3 }) {
  const actions = useCreateImagesCanvasActions();
  const authority = actions.inputImageAuthority(node.id, "image");
  const assetId = authority?.assetIds[0];
  const retainAssetPreview = actions.retainAssetPreview;
  const retainRunAssetPreview = actions.retainRunAssetPreview;
  React.useEffect(() => {
    if (!assetId || !authority) return;
    return authority.source === "workflow"
      ? retainAssetPreview(assetId)
      : retainRunAssetPreview(assetId);
  }, [assetId, authority, retainAssetPreview, retainRunAssetPreview]);
  const preview =
    assetId && authority?.source === "workflow"
      ? actions.assetPreview(assetId)
      : assetId
        ? actions.runAssetPreview(assetId)
        : undefined;
  const reportLoad = React.useCallback(() => {
    if (!preview || !authority) return;
    if (authority.source === "workflow") actions.assetPreviewLoaded(preview.asset.assetId, preview.token);
    else actions.runAssetPreviewLoaded(preview.asset.assetId, preview.token);
  }, [actions, authority, preview]);
  const reportError = React.useCallback(() => {
    if (!preview || !authority) return;
    if (authority.source === "workflow") actions.assetPreviewFailed(preview.asset.assetId, preview.token);
    else actions.runAssetPreviewFailed(preview.asset.assetId, preview.token);
  }, [actions, authority, preview]);
  const image = usePreviewImage(preview?.url, reportLoad, reportError);
  const [tool, setTool] = React.useState<AnnotationTool>("select");
  const [selectedId, setSelectedId] = React.useState<string>();
  const drawingIdRef = React.useRef<string | undefined>(undefined);
  const stageRef = React.useRef<Konva.Stage>(null);
  const transformerRef = React.useRef<Konva.Transformer>(null);

  React.useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage || !selectedId) {
      transformer?.nodes([]);
      return;
    }
    const selectedShape = node.data.shapes.find((shape) => shape.id === selectedId);
    if (selectedShape?.type !== "rectangle" && selectedShape?.type !== "ellipse") {
      transformer.nodes([]);
      return;
    }
    const selected = stage.findOne(`#annotation-${selectedId}`);
    transformer.nodes(selected ? [selected] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, node.data.shapes]);

  const replaceShapes = React.useCallback(
    (shapes: CreateImagesAnnotationShape[], draft = false) => {
      const update = (candidate: typeof node) => ({ ...candidate, data: { shapes } });
      if (draft) actions.updateNodeDraft(node.id, (candidate) =>
        candidate.type === "annotation" ? update(candidate) : candidate,
      );
      else actions.updateNode(node.id, (candidate) =>
        candidate.type === "annotation" ? update(candidate) : candidate,
      );
    },
    [actions, node.id],
  );

  const addShape = (nextTool: Exclude<AnnotationTool, "select" | "freehand">) => {
    if (node.data.shapes.length >= CREATE_IMAGES_MAX_ANNOTATION_SHAPES) return;
    const shape = nextShape(nextTool);
    replaceShapes([...node.data.shapes, shape]);
    setSelectedId(shape.id);
    setTool("select");
  };

  const selected = node.data.shapes.find((shape) => shape.id === selectedId);
  const mutateSelected = (update: (shape: CreateImagesAnnotationShape) => CreateImagesAnnotationShape) => {
    if (!selectedId) return;
    replaceShapes(updateShape(node.data.shapes, selectedId, update));
  };

  const shapeEvents = (shape: CreateImagesAnnotationShape) => ({
    id: `annotation-${shape.id}`,
    draggable: tool === "select",
    onClick: () => setSelectedId(shape.id),
    onTap: () => setSelectedId(shape.id),
    onDragStart: () => actions.beginNodeEdit(node.id, true),
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => {
      const x =
        event.target.x() / STAGE_WIDTH - (shape.type === "ellipse" ? shape.width / 2 : 0);
      const y =
        event.target.y() / STAGE_HEIGHT - (shape.type === "ellipse" ? shape.height / 2 : 0);
      replaceShapes(updateShape(node.data.shapes, shape.id, (candidate) => ({ ...candidate, x, y })), true);
      actions.commitNodeEdit(node.id);
    },
    onTransformStart: () => actions.beginNodeEdit(node.id, true),
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => {
      const target = event.target;
      const scaleX = target.scaleX();
      const scaleY = target.scaleY();
      target.scaleX(1);
      target.scaleY(1);
      replaceShapes(
        updateShape(node.data.shapes, shape.id, (candidate) =>
          candidate.type === "rectangle" || candidate.type === "ellipse"
            ? {
                ...candidate,
                x:
                  target.x() / STAGE_WIDTH -
                  (candidate.type === "ellipse" ? (candidate.width * scaleX) / 2 : 0),
                y:
                  target.y() / STAGE_HEIGHT -
                  (candidate.type === "ellipse" ? (candidate.height * scaleY) / 2 : 0),
                width: Math.min(2, Math.max(0.001, candidate.width * scaleX)),
                height: Math.min(2, Math.max(0.001, candidate.height * scaleY)),
              }
            : candidate,
        ),
        true,
      );
      actions.commitNodeEdit(node.id);
    },
  });

  return (
    <div className="nodrag nopan nowheel grid gap-2">
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Annotation tools">
        {([
          ["select", MousePointer2, "Select"],
          ["rectangle", Square, "Rectangle"],
          ["ellipse", Circle, "Ellipse"],
          ["arrow", ArrowRight, "Arrow"],
          ["freehand", Pencil, "Freehand"],
          ["text", Type, "Text"],
        ] as const).map(([value, Icon, label]) => (
          <button
            key={value}
            type="button"
            className="grid size-7 place-items-center rounded-control text-secondary outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
            data-active={tool === value ? "true" : "false"}
            aria-label={label}
            aria-pressed={tool === value}
            onClick={() => {
              if (value === "select" || value === "freehand") setTool(value);
              else addShape(value);
            }}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        ))}
        <button
          type="button"
          className="ml-auto grid size-7 place-items-center rounded-control text-red outline-none hover:bg-red/10 focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
          aria-label="Delete selected annotation"
          disabled={!selectedId}
          onClick={() => {
            replaceShapes(node.data.shapes.filter((shape) => shape.id !== selectedId));
            setSelectedId(undefined);
          }}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="create-images-annotation-stage relative overflow-hidden rounded-card border border-field bg-well">
        <Stage
          ref={stageRef}
          width={STAGE_WIDTH}
          height={STAGE_HEIGHT}
          aria-label="Annotation canvas"
          onPointerDown={(event) => {
            if (tool !== "freehand" || event.target !== event.target.getStage()) {
              if (event.target === event.target.getStage()) setSelectedId(undefined);
              return;
            }
            const point = event.target.getStage()?.getPointerPosition();
            if (!point || node.data.shapes.length >= CREATE_IMAGES_MAX_ANNOTATION_SHAPES) return;
            const id = `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            drawingIdRef.current = id;
            actions.beginNodeEdit(node.id, true);
            replaceShapes([
              ...node.data.shapes,
              {
                id,
                type: "freehand",
                x: 0,
                y: 0,
                points: [point.x / STAGE_WIDTH, point.y / STAGE_HEIGHT, point.x / STAGE_WIDTH, point.y / STAGE_HEIGHT],
                stroke: "accent",
                strokeWidth: 4,
              },
            ], true);
            setSelectedId(id);
          }}
          onPointerMove={(event) => {
            const id = drawingIdRef.current;
            if (!id) return;
            const point = event.target.getStage()?.getPointerPosition();
            if (!point) return;
            replaceShapes(
              updateShape(node.data.shapes, id, (shape) =>
                shape.type === "freehand"
                  ? { ...shape, points: [...shape.points, point.x / STAGE_WIDTH, point.y / STAGE_HEIGHT].slice(-4_096) }
                  : shape,
              ),
              true,
            );
          }}
          onPointerUp={() => {
            if (!drawingIdRef.current) return;
            drawingIdRef.current = undefined;
            actions.commitNodeEdit(node.id);
            setTool("select");
          }}
        >
          <Layer>
            {image ? <KonvaImage image={image} width={STAGE_WIDTH} height={STAGE_HEIGHT} /> : null}
            {node.data.shapes.map((shape) => {
              const common = {
                ...shapeEvents(shape),
                x: shape.x * STAGE_WIDTH,
                y: shape.y * STAGE_HEIGHT,
                stroke: COLOR_VALUES[shape.stroke],
                strokeWidth: Math.max(1, shape.strokeWidth / 2),
              };
              if (shape.type === "rectangle") return <Rect key={shape.id} {...common} width={shape.width * STAGE_WIDTH} height={shape.height * STAGE_HEIGHT} fill={shape.fill ? COLOR_VALUES[shape.fill] : undefined} />;
              if (shape.type === "ellipse") return <Ellipse key={shape.id} {...common} x={(shape.x + shape.width / 2) * STAGE_WIDTH} y={(shape.y + shape.height / 2) * STAGE_HEIGHT} radiusX={(shape.width * STAGE_WIDTH) / 2} radiusY={(shape.height * STAGE_HEIGHT) / 2} fill={shape.fill ? COLOR_VALUES[shape.fill] : undefined} />;
              if (shape.type === "arrow") return <Arrow key={shape.id} {...common} points={shape.points.map((value, index) => value * (index % 2 === 0 ? STAGE_WIDTH : STAGE_HEIGHT))} pointerLength={8} pointerWidth={8} />;
              if (shape.type === "freehand") return <Line key={shape.id} {...common} points={shape.points.map((value, index) => value * (index % 2 === 0 ? STAGE_WIDTH : STAGE_HEIGHT))} tension={0.25} />;
              return <KonvaText key={shape.id} {...common} text={shape.text} fontSize={Math.max(8, shape.fontSize / 4)} fill={COLOR_VALUES[shape.stroke]} />;
            })}
            <Transformer ref={transformerRef} rotateEnabled={false} flipEnabled={false} boundBoxFunc={(_oldBox, nextBox) => nextBox.width < 8 || nextBox.height < 8 ? _oldBox : nextBox} />
          </Layer>
        </Stage>
        {!image ? <div className="pointer-events-none absolute inset-0 grid place-items-center px-4 text-center text-mini text-tertiary">Connect and run an image input to annotate it.</div> : null}
      </div>
      {selected ? (
        <div className="grid grid-cols-2 gap-2" aria-label="Selected annotation properties">
          {selected.type === "text" ? (
            <label className="col-span-2 grid gap-1 text-mini text-tertiary">
              Text
              <input
                className="rounded-control border border-field bg-input px-2 py-1 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                maxLength={240}
                value={selected.text}
                onChange={(event) =>
                  mutateSelected((shape) =>
                    shape.type === "text" ? { ...shape, text: event.target.value } : shape,
                  )
                }
              />
            </label>
          ) : null}
          <label className="grid gap-1 text-mini text-tertiary">
            Stroke
            <select className="create-images-node-select min-w-0" value={selected.stroke} onChange={(event) => mutateSelected((shape) => ({ ...shape, stroke: event.target.value as CreateImagesAnnotationColor }))}>
              {CREATE_IMAGES_ANNOTATION_COLORS.map((color) => <option key={color} value={color}>{color}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-mini text-tertiary">
            Stroke width
            <input className="rounded-control border border-field bg-input px-2 py-1 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring" type="number" min="0.5" max="64" step="0.5" value={selected.strokeWidth} onChange={(event) => mutateSelected((shape) => ({ ...shape, strokeWidth: Math.min(64, Math.max(0.5, Number(event.target.value) || 0.5)) }))} />
          </label>
          {selected.type === "rectangle" || selected.type === "ellipse" ? (
            <label className="grid gap-1 text-mini text-tertiary">
              Fill
              <select
                className="create-images-node-select min-w-0"
                value={selected.fill ?? "none"}
                onChange={(event) =>
                  mutateSelected((shape) => {
                    if (shape.type !== "rectangle" && shape.type !== "ellipse") return shape;
                    const fill = event.target.value;
                    if (fill === "none") {
                      const { fill: _fill, ...withoutFill } = shape;
                      return withoutFill;
                    }
                    return { ...shape, fill: fill as CreateImagesAnnotationColor };
                  })
                }
              >
                <option value="none">None</option>
                {CREATE_IMAGES_ANNOTATION_COLORS.map((color) => <option key={color} value={color}>{color}</option>)}
              </select>
            </label>
          ) : null}
          <label className="grid gap-1 text-mini text-tertiary">
            Horizontal position (%)
            <input
              className="rounded-control border border-field bg-input px-2 py-1 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              type="number"
              min="-100"
              max="200"
              value={Math.round(selected.x * 100)}
              onChange={(event) => mutateSelected((shape) => ({ ...shape, x: Math.min(2, Math.max(-1, Number(event.target.value) / 100 || 0)) }))}
            />
          </label>
          <label className="grid gap-1 text-mini text-tertiary">
            Vertical position (%)
            <input
              className="rounded-control border border-field bg-input px-2 py-1 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              type="number"
              min="-100"
              max="200"
              value={Math.round(selected.y * 100)}
              onChange={(event) => mutateSelected((shape) => ({ ...shape, y: Math.min(2, Math.max(-1, Number(event.target.value) / 100 || 0)) }))}
            />
          </label>
          {selected.type === "text" ? (
            <label className="grid gap-1 text-mini text-tertiary">
              Text size
              <input
                className="rounded-control border border-field bg-input px-2 py-1 text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                type="number"
                min="8"
                max="256"
                value={selected.fontSize}
                onChange={(event) =>
                  mutateSelected((shape) =>
                    shape.type === "text"
                      ? { ...shape, fontSize: Math.min(256, Math.max(8, Number(event.target.value) || 8)) }
                      : shape,
                  )
                }
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
