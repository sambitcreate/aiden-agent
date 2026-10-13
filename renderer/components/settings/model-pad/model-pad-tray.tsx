import { X } from "lucide-react";
import { ProviderIcon } from "../../provider-icon";
import { InfoHint } from "../../ui-info-hint";
import type { ModelEntry } from "../../../lib/model-picker-data";
import type { ModelPadPlacementKind } from "../../../lib/model-pad-layout";
import { cn } from "../../../lib/ui-utils";

export interface ModelPadTrayRow {
  entry: ModelEntry;
  kind: ModelPadPlacementKind;
  /** "Placed by you", "Benchmark-assisted", … */
  sourceLabel: string;
  /** "Provider · also via …". */
  secondary: string;
}

/**
 * "On your Pad": the placed models top to bottom as the Pad shows them. A row
 * and its marker share one hot state; choosing a row focuses its marker.
 */
export function ModelPadTray({
  rows,
  hotValue,
  selectedValue,
  onHotChange,
  onShow,
  onRemove,
}: {
  rows: readonly ModelPadTrayRow[];
  hotValue?: string;
  selectedValue?: string;
  onHotChange: (value: string, hot: boolean) => void;
  onShow: (value: string) => void;
  onRemove: (entry: ModelEntry) => void;
}) {
  return (
    <aside className="model-pad-tray min-w-0" aria-label="On your Pad">
      <div className="flex items-center justify-between px-1 pb-1.5 pt-0.5 text-small text-secondary">
        <span className="flex items-center gap-1">
          On your Pad
          <InfoHint topic="models on your Pad">
            <p>
              Positions for models that are temporarily unavailable are kept and come back with
              them.
            </p>
          </InfoHint>
        </span>
        {rows.length > 0 ? <span className="tabular-nums text-tertiary">{rows.length}</span> : null}
      </div>
      {rows.length > 0 ? (
        <ul className="model-pad-tray-list grid gap-px">
          {rows.map(({ entry, kind, sourceLabel, secondary }) => {
            const label = `${entry.label} from ${entry.providerLabel}`;
            return (
              <li
                key={entry.value}
                data-value={entry.value}
                data-hot={hotValue === entry.value ? "true" : undefined}
                data-selected={selectedValue === entry.value ? "true" : undefined}
                className="model-pad-tray-row group flex min-h-9 items-center gap-1 rounded-control pr-1 transition-colors duration-(--motion-duration) ease-standard hover:bg-list-hover data-[hot=true]:bg-list-hover data-[selected=true]:bg-list-selection"
                onPointerEnter={() => onHotChange(entry.value, true)}
                onPointerLeave={() => onHotChange(entry.value, false)}
              >
                <button
                  type="button"
                  aria-label={`${label}, ${sourceLabel}. Show on the Pad`}
                  className="flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-control py-1 pl-1.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
                  onClick={() => onShow(entry.value)}
                  onFocus={() => onHotChange(entry.value, true)}
                  onBlur={() => onHotChange(entry.value, false)}
                >
                  <ProviderIcon
                    providerId={entry.providerId}
                    providerLabel={entry.providerLabel}
                    modelId={entry.model}
                    artwork={entry.providerArtwork}
                    className="size-4 shrink-0 text-tertiary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small-strong text-primary">{entry.label}</span>
                    <span className="block truncate text-mini text-tertiary">{secondary}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    title={sourceLabel}
                    data-placement-source={kind}
                    className="model-pad-tray-glyph"
                  />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${label} from Pad`}
                  className={cn(
                    "grid size-6 shrink-0 cursor-default place-items-center rounded-lg text-tertiary opacity-0 outline-none transition-opacity duration-(--motion-duration) ease-standard hover:bg-control hover:text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus-ring group-hover:opacity-100 group-data-[hot=true]:opacity-100",
                  )}
                  onClick={() => onRemove(entry)}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-1 py-4 text-small text-tertiary">Models you add appear here.</p>
      )}
    </aside>
  );
}
