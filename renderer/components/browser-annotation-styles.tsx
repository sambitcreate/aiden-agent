import * as React from "react";
import { Link2, Unlink2, X } from "lucide-react";
import type { BrowserElement } from "../shared/browser";
import { browserAnnotationDimensionStyles } from "../lib/browser-annotation-editing";
import { Button, Input } from "./ui";

export function BrowserAnnotationStyles({ elements, styles, disabled, onChange }: {
  elements: BrowserElement[]; styles: Record<string, Record<string, string>>; disabled: boolean;
  onChange: (elementRef: string, styles: Record<string, string>) => void;
}) {
  const [selectedRef, setSelectedRef] = React.useState(elements[0]?.ref ?? "");
  const [ratioLocked, setRatioLocked] = React.useState(true);
  const selected = elements.find((element) => element.ref === selectedRef) ?? elements[0];
  if (!selected) return null;
  const changes = styles[selected.ref] ?? {};
  const value = (property: string) => changes[property] ?? selected.attributes?.[`style:${property}`] ?? "";
  const patch = (next: Record<string, string>) => onChange(selected.ref, { ...changes, ...next });
  const remove = (property: string) => onChange(selected.ref, Object.fromEntries(Object.entries(changes).filter(([key]) => key !== property)));
  const unit = (label: string, property: string, placeholder: string, min = 0, max?: number) => <label className="browser-annotation-style-field">{label}<Input type="number" aria-label={label} min={min} max={max} placeholder={placeholder} value={value(property).replace(/px$/, "")} onChange={(event) => event.target.value.trim() ? patch({ [property]: `${event.target.value}px`, ...(property === "border-width" ? { "border-style": "solid" } : {}) }) : remove(property)} /></label>;
  const text = (label: string, property: string, placeholder: string) => <label className="browser-annotation-style-field">{label}<Input aria-label={label} placeholder={placeholder} value={value(property)} onChange={(event) => event.target.value ? patch({ [property]: event.target.value }) : remove(property)} /></label>;
  const color = (label: string, property: string) => <label className="browser-annotation-style-field">{label}<span className="browser-annotation-color"><input type="color" aria-label={`${label} picker`} value={/^#[\da-f]{6}$/i.test(value(property)) ? value(property) : "#000000"} onChange={(event) => patch({ [property]: event.target.value })} /><Input aria-label={`${label} value`} placeholder="CSS color" value={value(property)} onChange={(event) => event.target.value ? patch({ [property]: event.target.value }) : remove(property)} /></span></label>;
  return <details className="browser-annotation-details"><summary>Suggested style changes</summary><fieldset className="browser-annotation-styles" disabled={disabled}>
    <label className="browser-setting-row">Style element<select className="browser-select" aria-label="Element to style" value={selected.ref} onChange={(event) => setSelectedRef(event.target.value)}>{elements.map((element, index) => <option key={element.ref} value={element.ref}>{index + 1}. {element.text || element.tag}</option>)}</select></label>
    <section aria-label="Text styles"><h4>Text</h4>
      <label className="browser-annotation-style-field">Font<select className="browser-select" aria-label="Font" value={value("font-family") || ""} onChange={(event) => patch({ "font-family": event.target.value })}><option value="">Current font</option>{["inherit", "system-ui", "sans-serif", "serif", "monospace"].map((font) => <option key={font} value={font}>{font}</option>)}</select></label>
      {unit("Font size", "font-size", "16", 1, 300)}
      <label className="browser-annotation-style-field">Font weight<select className="browser-select" aria-label="Font weight" value={value("font-weight") || "400"} onChange={(event) => patch({ "font-weight": event.target.value })}>{[300, 400, 500, 600, 700, 800, 900].map((weight) => <option key={weight} value={weight}>{weight}</option>)}</select></label>
      {text("Line height", "line-height", "normal / 1.4")}
    </section>
    <section aria-label="Color styles"><h4>Colors</h4>{color("Text color", "color")}{color("Background", "background-color")}<label className="browser-annotation-style-field">Opacity<input type="range" aria-label="Opacity" min={0} max={1} step={0.05} value={value("opacity") || "1"} onChange={(event) => patch({ opacity: event.target.value })} /></label></section>
    <section aria-label="Border styles"><h4>Borders</h4>{unit("Radius", "border-radius", "0", 0, 300)}{color("Border color", "border-color")}{unit("Border width", "border-width", "0", 0, 100)}</section>
    <section aria-label="Sizing styles"><h4>Sizing<Button size="small" variant="transparent" iconOnly aria-label={ratioLocked ? "Unlock element aspect ratio" : "Lock element aspect ratio"} aria-pressed={ratioLocked} onClick={() => setRatioLocked((current) => !current)}>{ratioLocked ? <Link2 /> : <Unlink2 />}</Button></h4>
      {(["width", "height"] as const).map((dimension) => <label className="browser-annotation-style-field" key={dimension}>{dimension === "width" ? "Width" : "Height"}<Input type="number" min={1} aria-label={`Element ${dimension}`} placeholder={String(Math.round(selected.bounds[dimension]))} value={changes[dimension]?.replace(/px$/, "") ?? ""} onChange={(event) => {
        if (!event.target.value) { remove(dimension); return; }
        patch(browserAnnotationDimensionStyles(dimension, event.target.value, ratioLocked ? selected.bounds.width / Math.max(1, selected.bounds.height) : null));
      }} /></label>)}
      {text("Padding", "padding", "0 0 0 0")}{text("Margin", "margin", "0 0 0 0")}{text("Gap", "gap", "0px")}
    </section>
    {Object.entries(changes).map(([property, current]) => <div className="browser-setting-row" key={property}><code>{property}: {current}</code><Button size="small" variant="transparent" iconOnly aria-label={`Remove ${property} change`} onClick={() => remove(property)}><X /></Button></div>)}
  </fieldset></details>;
}
