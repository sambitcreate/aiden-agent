import type * as React from "react";
import {
  MODEL_PAD_PLACEMENT_KIND_LABELS,
  type ModelPadPlacementKind,
} from "../../lib/model-pad-layout";

const LEGEND_KINDS: readonly ModelPadPlacementKind[] = ["personal", "benchmark"];

function LegendMarker({ kind, label }: { kind: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="model-pad-legend-marker" data-placement-source={kind} />
      {label}
    </span>
  );
}

/**
 * Key for the Pad's markers: solid for personal, hollow ring for data-assisted,
 * and a dashed ring for previewed suggestions while there are any. Trailing
 * content (suggestion actions) replaces the hover hint.
 */
export function ModelPadLegend({
  heightCaption,
  showSuggestions = false,
  children,
}: {
  /** "Height: <Metric>", shown while some height comes from a benchmark score. */
  heightCaption?: string;
  showSuggestions?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="model-pad-legend mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-tertiary">
      {LEGEND_KINDS.map((kind) => (
        <LegendMarker key={kind} kind={kind} label={MODEL_PAD_PLACEMENT_KIND_LABELS[kind]} />
      ))}
      {showSuggestions ? <LegendMarker kind="suggestion" label="Suggested" /> : null}
      {heightCaption ? <span>{heightCaption}</span> : null}
      <span className="ml-auto">
        {children ?? "Hover, focus, or select a marker to see its model."}
      </span>
    </div>
  );
}
