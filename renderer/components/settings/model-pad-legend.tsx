import {
  MODEL_PAD_PLACEMENT_KIND_LABELS,
  type ModelPadPlacementKind,
} from "../../lib/model-pad-layout";

const LEGEND_KINDS: readonly ModelPadPlacementKind[] = ["personal", "benchmark"];

/** Key for the Pad's two marker kinds: solid for personal, hollow ring for data-assisted. */
export function ModelPadLegend() {
  return (
    <div className="model-pad-legend mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-tertiary">
      {LEGEND_KINDS.map((kind) => (
        <span key={kind} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="model-pad-legend-marker"
            data-placement-source={kind}
          />
          {MODEL_PAD_PLACEMENT_KIND_LABELS[kind]}
        </span>
      ))}
      <span className="ml-auto">Hover, focus, or select a marker to see its model.</span>
    </div>
  );
}
