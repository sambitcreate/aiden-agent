const LEGEND_ITEMS = [
  { source: "personal", label: "Placed by you" },
  { source: "benchmark", label: "Benchmark-assisted" },
] as const;

/** Key for the Pad's two marker kinds: solid for personal, hollow ring for data-assisted. */
export function ModelPadLegend() {
  return (
    <div className="model-pad-legend mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-mini text-tertiary">
      {LEGEND_ITEMS.map((item) => (
        <span key={item.source} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="model-pad-legend-marker"
            data-placement-source={item.source}
          />
          {item.label}
        </span>
      ))}
      <span className="ml-auto">Hover, focus, or select a marker to see its model.</span>
    </div>
  );
}
