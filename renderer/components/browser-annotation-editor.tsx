import * as React from "react";
import { Eraser, MousePointer2, Pencil, Scan, Undo2, X } from "lucide-react";
import type { BrowserAnnotation, BrowserBounds, BrowserCommandResult, BrowserElement, BrowserSnapshot, BrowserStylePreview } from "../shared/browser";
import { browserAnnotationRegion, browserElementAtPoint } from "../lib/browser-ui-state";
import { browserAnnotationElementBounds, browserAnnotationStylePreview, eraseBrowserAnnotationAtPoint } from "../lib/browser-annotation-editing";
import { scheduleBrowserAnnotationPreview } from "../lib/browser-annotation-preview-queue";
import { BrowserAnnotationStyles } from "./browser-annotation-styles";
import { Button, Textarea } from "./ui";

export function BrowserAnnotationEditor({ snapshot, initial, pending, onCancel, onSubmit, onPreview }: {
  snapshot: BrowserSnapshot;
  initial?: BrowserAnnotation;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (annotation: BrowserAnnotation) => void;
  onPreview?: (changes: BrowserStylePreview[]) => Promise<BrowserCommandResult | null>;
}) {
  const [mode, setMode] = React.useState<"element" | "region" | "draw" | "erase">("element");
  const [elements, setElements] = React.useState<BrowserElement[]>(initial?.elements ?? []);
  const [regions, setRegions] = React.useState<BrowserBounds[]>(initial?.regions ?? []);
  const [strokes, setStrokes] = React.useState<BrowserAnnotation["strokes"]>(initial?.strokes ?? []);
  const [comment, setComment] = React.useState(initial?.comment ?? "");
  const [styles, setStyles] = React.useState<Record<string, Record<string, string>>>(() => Object.fromEntries((initial?.elementStyleChanges ?? []).map((element) => [element.ref, Object.fromEntries(Object.entries(element.changes).map(([property, change]) => [property, change.current]))])));
  const [elementStyleChanges, setElementStyleChanges] = React.useState(initial?.elementStyleChanges);
  const [previewPending, setPreviewPending] = React.useState(false);
  const [previewError, setPreviewError] = React.useState(false);
  const [previewRetry, setPreviewRetry] = React.useState(0);
  const completedPreviewRef = React.useRef("[]");
  const [hovered, setHovered] = React.useState<BrowserElement | null>(null);
  const [draftRegion, setDraftRegion] = React.useState<BrowserBounds | null>(null);
  const svgRef = React.useRef<SVGSVGElement>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const image = snapshot.image ?? initial?.image;
  const width = image?.width ?? snapshot.tab.viewport.width;
  const height = image?.height ?? snapshot.tab.viewport.height;
  const selectedElements = elements.map((element) => {
    const updated = snapshot.elements.find((candidate) => candidate.selector === element.selector);
    return updated ? { ...updated, ref: element.ref, attributes: { ...element.attributes, ...updated.attributes }, source: updated.source || element.source } : element;
  });
  const previewKey = JSON.stringify(browserAnnotationStylePreview(selectedElements, styles));
  React.useEffect(() => {
    if (!onPreview) return;
    setPreviewPending(true); setPreviewError(false);
    return scheduleBrowserAnnotationPreview(() => onPreview(JSON.parse(previewKey) as BrowserStylePreview[]), (result) => {
      if (result) { completedPreviewRef.current = previewKey; setElementStyleChanges(result.elementStyleChanges); }
      setPreviewError(!result); setPreviewPending(false);
    });
  }, [previewKey, onPreview, previewRetry]);
  const point = (event: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(width, (event.clientX - rect.x) * width / rect.width)), y: Math.max(0, Math.min(height, (event.clientY - rect.y) * height / rect.height)) };
  };
  const elementBounds = (element: BrowserElement) => browserAnnotationElementBounds(element, snapshot, image);
  const removeElement = (ref: string) => {
    setElements((current) => current.filter((element) => element.ref !== ref));
    setStyles((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== ref)));
  };
  const toggleElement = (element: BrowserElement) => {
    const existing = elements.find((item) => item.ref === element.ref || item.selector === element.selector);
    if (existing) removeElement(existing.ref);
    else setElements((current) => [...current, element]);
  };
  const erase = (point: { x: number; y: number }) => {
    const next = eraseBrowserAnnotationAtPoint({ elements: selectedElements, regions, strokes }, point, { ...snapshot, image });
    setElements(next.elements); setRegions(next.regions); setStrokes(next.strokes);
    const retained = new Set(next.elements.map((element) => element.ref));
    setStyles((current) => Object.fromEntries(Object.entries(current).filter(([key]) => retained.has(key))));
  };
  const finish = (event: React.PointerEvent) => {
    const start = startRef.current;
    if (!start) return;
    startRef.current = null;
    if (mode === "region") {
      const region = browserAnnotationRegion(start, point(event));
      if (region.width >= 2 && region.height >= 2) setRegions((current) => [...current, region]);
      setDraftRegion(null);
    }
  };
  const previewReady = !onPreview || (!previewPending && !previewError && previewKey === completedPreviewRef.current);
  const canSubmit = !pending && previewReady && Boolean(elements.length || regions.length || strokes.length || comment.trim());
  const submit = () => { if (canSubmit) onSubmit({ ...initial, url: snapshot.tab.url, elements: selectedElements, regions, strokes, comment, elementStyleChanges, image }); };
  return <section className="browser-annotation" aria-label="Annotate browser" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); submit(); }
  }}>
    <div className="browser-annotation-toolbar">
      <div className="browser-control-group" role="group" aria-label="Annotation mode">
        <Button size="small" variant={mode === "element" ? "muted" : "transparent"} aria-pressed={mode === "element"} onClick={() => setMode("element")}><MousePointer2 />Element</Button>
        <Button size="small" variant={mode === "region" ? "muted" : "transparent"} aria-pressed={mode === "region"} onClick={() => setMode("region")}><Scan />Region</Button>
        <Button size="small" variant={mode === "draw" ? "muted" : "transparent"} aria-pressed={mode === "draw"} onClick={() => setMode("draw")}><Pencil />Draw</Button>
        <Button size="small" variant={mode === "erase" ? "muted" : "transparent"} aria-pressed={mode === "erase"} onClick={() => setMode("erase")}><Eraser />Erase</Button>
      </div>
      <Button size="small" variant="transparent" iconOnly aria-label="Undo annotation" disabled={!elements.length && !regions.length && !strokes.length} onClick={() => { if (mode === "draw" && strokes.length) setStrokes((current) => current.slice(0, -1)); else if (mode === "region" && regions.length) setRegions((current) => current.slice(0, -1)); else if (elements.length) removeElement(elements[elements.length - 1].ref); else if (strokes.length) setStrokes((current) => current.slice(0, -1)); else setRegions((current) => current.slice(0, -1)); }}><Undo2 /></Button>
      <Button size="small" variant="transparent" iconOnly aria-label="Cancel annotation" onClick={onCancel}><X /></Button>
    </div>
    <div className="browser-annotation-canvas">
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} aria-label="Browser page annotation canvas" role="img" style={{ aspectRatio: `${width} / ${height}`, cursor: mode === "element" ? "crosshair" : "crosshair" }} onPointerDown={(event) => {
        if (event.button !== 0 || pending) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        const current = point(event); startRef.current = current;
        if (mode === "element") {
          const element = browserElementAtPoint(snapshot.elements, { x: current.x * snapshot.tab.viewport.width / width, y: current.y * snapshot.tab.viewport.height / height });
          if (element) toggleElement(element);
        } else if (mode === "draw") setStrokes((currentStrokes) => [...currentStrokes, [current]]);
        else if (mode === "erase") erase(current);
      }} onPointerMove={(event) => {
        if (pending) return;
        const current = point(event);
        if (mode === "element") {
          setHovered(browserElementAtPoint(snapshot.elements, { x: current.x * snapshot.tab.viewport.width / width, y: current.y * snapshot.tab.viewport.height / height }));
        }
        if (!startRef.current) return;
        if (mode === "region") setDraftRegion(browserAnnotationRegion(startRef.current, current));
        if (mode === "draw") setStrokes((currentStrokes) => currentStrokes.map((stroke, index) => index === currentStrokes.length - 1 ? [...stroke, current] : stroke));
        if (mode === "erase") erase(current);
      }} onPointerUp={finish} onPointerCancel={() => { startRef.current = null; setDraftRegion(null); }} onPointerLeave={() => setHovered(null)}>
        {image ? <image href={`data:${image.mimeType};base64,${image.data}`} width={width} height={height} /> : null}
        {hovered ? <rect {...elementBounds(hovered)} className="browser-annotation-hover" vectorEffect="non-scaling-stroke" /> : null}
        {selectedElements.map((element, index) => <g key={element.ref}><rect {...elementBounds(element)} className="browser-annotation-selection" vectorEffect="non-scaling-stroke" /><text x={elementBounds(element).x + 4} y={elementBounds(element).y + 16} className="browser-annotation-number">{index + 1}</text></g>)}
        {[...regions, ...(draftRegion ? [draftRegion] : [])].map((region, index) => <rect key={index} {...region} className="browser-annotation-selection" vectorEffect="non-scaling-stroke" />)}
        {strokes.map((stroke, index) => <polyline key={index} points={stroke.map((item) => `${item.x},${item.y}`).join(" ")} className="browser-annotation-stroke" vectorEffect="non-scaling-stroke" />)}
      </svg>
    </div>
    <div className="browser-annotation-composer">
      {initial?.selectedText ? <blockquote className="browser-annotation-selected-text">{initial.selectedText}</blockquote> : null}
      {elements.length ? <div className="browser-annotation-elements" aria-label="Selected elements">{elements.map((element, index) => <div key={element.ref} className="browser-annotation-element"><span>{index + 1}. {element.text || element.tag}</span><code title={element.source ?? element.selector}>{element.source ?? element.selector}</code><Button size="small" variant="transparent" iconOnly aria-label={`Remove ${element.text || element.tag}`} onClick={() => removeElement(element.ref)}><X /></Button></div>)}</div> : null}
      <details className="browser-annotation-details"><summary>Select an element by name</summary><select aria-label="Element to annotate" className="browser-select" value="" onChange={(event) => { const element = snapshot.elements.find((item) => item.ref === event.target.value); if (element && !elements.some((item) => item.selector === element.selector)) setElements((current) => [...current, element]); }}><option value="">Choose an element…</option>{snapshot.elements.map((element) => <option key={element.ref} value={element.ref}>{element.tag}: {element.text || element.selector}</option>)}</select></details>
      <BrowserAnnotationStyles elements={selectedElements} styles={styles} disabled={pending} onChange={(ref, next) => setStyles((current) => ({ ...current, [ref]: next }))} />
      {previewPending ? <span className="text-small text-secondary" role="status">Updating style preview…</span> : previewError ? <div className="browser-setting-row" role="alert">The style preview could not be updated.<Button size="small" onClick={() => setPreviewRetry((current) => current + 1)}>Retry</Button></div> : null}
      <Textarea aria-label="Annotation comment" placeholder="What would you like Aiden to change?" value={comment} onChange={(event) => setComment(event.target.value)} rows={2} />
      <div className="browser-annotation-footer"><span className="text-small text-secondary">{elements.length} elements · {regions.length} regions · {strokes.length} drawings</span><Button size="small" disabled={!canSubmit} aria-keyshortcuts="Meta+Enter Control+Enter" title="Add to chat (⌘Enter)" onClick={submit}>{pending ? "Adding…" : "Add to chat"}</Button></div>
    </div>
  </section>;
}
