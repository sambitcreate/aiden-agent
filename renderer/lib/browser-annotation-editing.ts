import type { BrowserAnnotation, BrowserBounds, BrowserElement, BrowserSnapshot, BrowserStylePreview } from "../shared/browser";

export function browserAnnotationElementBounds(element: BrowserElement, snapshot: BrowserSnapshot, image = snapshot.image): BrowserBounds {
  const scaleX = image ? image.width / snapshot.tab.viewport.width : 1;
  const scaleY = image ? image.height / snapshot.tab.viewport.height : 1;
  return { x: element.bounds.x * scaleX, y: element.bounds.y * scaleY, width: element.bounds.width * scaleX, height: element.bounds.height * scaleY };
}

/** Erase the topmost selected element, then a region, then a drawing, as in the picker. */
export function eraseBrowserAnnotationAtPoint(annotation: Pick<BrowserAnnotation, "elements" | "regions" | "strokes">, point: { x: number; y: number }, snapshot: BrowserSnapshot): Pick<BrowserAnnotation, "elements" | "regions" | "strokes"> {
  const contains = (box: BrowserBounds) => point.x >= box.x && point.y >= box.y && point.x <= box.x + box.width && point.y <= box.y + box.height;
  const element = [...annotation.elements].reverse().find((item) => contains(browserAnnotationElementBounds(item, snapshot)));
  if (element) return { ...annotation, elements: annotation.elements.filter((item) => item.ref !== element.ref) };
  const region = annotation.regions.findIndex(contains);
  if (region >= 0) return { ...annotation, regions: annotation.regions.filter((_, index) => index !== region) };
  const stroke = annotation.strokes.findIndex((points) => {
    if (!points.length) return false;
    const xs = points.map((value) => value.x), ys = points.map((value) => value.y);
    return contains({ x: Math.min(...xs) - 3, y: Math.min(...ys) - 3, width: Math.max(...xs) - Math.min(...xs) + 6, height: Math.max(...ys) - Math.min(...ys) + 6 });
  });
  return stroke >= 0 ? { ...annotation, strokes: annotation.strokes.filter((_, index) => index !== stroke) } : annotation;
}

export function browserAnnotationStylePreview(elements: BrowserElement[], styles: Record<string, Record<string, string>>): BrowserStylePreview[] {
  // Empty desired styles still identify selected nodes for fresh snapshot bounds
  // after restoring the last edited property.
  return elements.map((element) => ({ ref: element.ref, selector: element.selector, styles: styles[element.ref] ?? {} }));
}

export function browserAnnotationDimensionStyles(property: "width" | "height", value: string, ratio: number | null): Record<string, string> {
  const dimension = Number(value);
  if (!value.trim() || !Number.isFinite(dimension) || dimension <= 0) return {};
  return { [property]: `${dimension}px`, ...(ratio && ratio > 0 ? { [property === "width" ? "height" : "width"]: `${Math.max(1, Math.round(property === "width" ? dimension / ratio : dimension * ratio))}px` } : {}) };
}
