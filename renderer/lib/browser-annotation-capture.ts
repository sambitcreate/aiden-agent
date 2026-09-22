import type { BrowserAnnotation, BrowserBounds, BrowserSnapshot } from "../shared/browser";

type AnnotationPaintContext = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "translate" | "strokeRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "fillText" | "strokeText" | "strokeStyle" | "fillStyle" | "lineWidth" | "lineCap" | "lineJoin" | "font">;

/** Paint the same selected boxes and drawings that the editor presents. */
export function paintBrowserAnnotation(context: AnnotationPaintContext, annotation: BrowserAnnotation, snapshot: BrowserSnapshot, crop: BrowserBounds, colors: { foreground: string; background: string }): void {
  if (!annotation.image) return;
  const scaleX = annotation.image.width / snapshot.tab.viewport.width;
  const scaleY = annotation.image.height / snapshot.tab.viewport.height;
  const boxes = annotation.elements.map((element) => ({ x: element.bounds.x * scaleX, y: element.bounds.y * scaleY, width: element.bounds.width * scaleX, height: element.bounds.height * scaleY }));
  boxes.push(...annotation.regions);
  context.save(); context.translate(-crop.x, -crop.y);
  context.lineCap = "round"; context.lineJoin = "round";
  for (const [index, box] of boxes.entries()) {
    context.strokeStyle = colors.background; context.lineWidth = 4; context.strokeRect(box.x, box.y, box.width, box.height);
    context.strokeStyle = colors.foreground; context.lineWidth = 1.5; context.strokeRect(box.x, box.y, box.width, box.height);
    if (index < annotation.elements.length) {
      context.font = "bold 14px system-ui"; context.strokeStyle = colors.background; context.lineWidth = 3;
      context.strokeText(String(index + 1), box.x + 4, box.y + 16);
      context.fillStyle = colors.foreground; context.fillText(String(index + 1), box.x + 4, box.y + 16);
    }
  }
  for (const stroke of annotation.strokes) {
    if (!stroke.length) continue;
    for (const [color, width] of [[colors.background, 5], [colors.foreground, 2]] as const) {
      context.strokeStyle = color; context.lineWidth = width; context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      if (stroke.length === 1) context.lineTo(stroke[0].x + .1, stroke[0].y);
      context.stroke();
    }
  }
  context.restore();
}

export function browserAnnotationCropBounds(annotation: BrowserAnnotation, snapshot: BrowserSnapshot): BrowserBounds | null {
  const image = annotation.image;
  if (!image) return null;
  const scaleX = image.width / snapshot.tab.viewport.width;
  const scaleY = image.height / snapshot.tab.viewport.height;
  const bounds: BrowserBounds[] = annotation.elements.map((element) => ({ x: element.bounds.x * scaleX, y: element.bounds.y * scaleY, width: element.bounds.width * scaleX, height: element.bounds.height * scaleY }));
  bounds.push(...annotation.regions);
  for (const stroke of annotation.strokes) {
    if (!stroke.length) continue;
    const xs = stroke.map((point) => point.x); const ys = stroke.map((point) => point.y);
    bounds.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
  }
  const finite = bounds.filter((box) => [box.x, box.y, box.width, box.height].every(Number.isFinite));
  if (!finite.length) return null;
  const x = Math.max(0, Math.floor(Math.min(...finite.map((box) => box.x)) - 8));
  const y = Math.max(0, Math.floor(Math.min(...finite.map((box) => box.y)) - 8));
  const right = Math.min(image.width, Math.ceil(Math.max(...finite.map((box) => box.x + box.width)) + 8));
  const bottom = Math.min(image.height, Math.ceil(Math.max(...finite.map((box) => box.y + box.height)) + 8));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Crop the captured frame, keeping the pick stable even if the live page changes. */
export async function captureBrowserAnnotation(annotation: BrowserAnnotation, snapshot: BrowserSnapshot): Promise<BrowserAnnotation> {
  const crop = browserAnnotationCropBounds(annotation, snapshot);
  if (!annotation.image || !crop) return annotation;
  const bytes = Uint8Array.from(atob(annotation.image.data), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: annotation.image.mimeType }));
  try {
    const canvas = document.createElement("canvas"); canvas.width = crop.width; canvas.height = crop.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image capture is unavailable.");
    context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    const theme = getComputedStyle(document.documentElement);
    paintBrowserAnnotation(context, annotation, snapshot, crop, {
      foreground: theme.getPropertyValue("--text-primary").trim(),
      background: theme.getPropertyValue("--surface-popover").trim(),
    });
    const data = canvas.toDataURL("image/png").split(",")[1];
    if (!data) throw new Error("The selected image could not be captured.");
    return { ...annotation, imageBounds: crop, image: { data, mimeType: "image/png", width: crop.width, height: crop.height } };
  } finally { bitmap.close(); }
}
