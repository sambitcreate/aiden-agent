import { Check, Copy, Download, FolderOpen } from "lucide-react";
import * as React from "react";
import { Button, Text } from "../../components/ui";
import type { GalleryItem } from "../../shared/images/ipc-types";
import type { ImageModelOption } from "../../shared/images/port";
import { detailRows, filmstripWindow, positionLabel, promptLikelyClamped } from "./viewer-core";

/** An extra action the host offers on the viewed image, such as Use as Input. */
export interface ViewerAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onSelect(item: GalleryItem): void;
}

const FILMSTRIP_SIZE = 11;

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const formatViewerTime = (timestamp: number) => timeFormat.format(timestamp);

/** The prompt, four lines at rest; a longer one opens in place behind "Show full prompt". */
function ViewerPrompt({ prompt }: { prompt: string }) {
  const id = React.useId();
  const text = React.useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [clamped, setClamped] = React.useState(() => promptLikelyClamped(prompt));
  React.useEffect(() => {
    const element = text.current;
    if (!element || expanded) return;
    setClamped(element.scrollHeight > element.clientHeight + 1);
  }, [prompt, expanded]);
  return (
    <section aria-label="Prompt" className="flex flex-col items-start gap-1">
      <Text variant="small" color="secondary">Prompt</Text>
      <p ref={text} id={id} className="image-viewer-prompt" data-expanded={expanded ? "true" : undefined}>
        {prompt}
      </p>
      {clamped || expanded ? (
        <Button size="small" variant="transparent" className="-ml-3" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((open) => !open)}>
          {expanded ? "Show less" : "Show full prompt"}
        </Button>
      ) : null}
    </section>
  );
}

/** The side panel: where the image sits in the set, its prompt, what to do with it and what made it. */
export function ViewerPanel({
  item,
  index,
  count,
  models = [],
  saveFolderLabel,
  revealLabel,
  actions = [],
  onSave,
  onCopy,
  onReveal,
  formatTime = formatViewerTime,
}: {
  item: GalleryItem;
  index: number;
  count: number;
  models?: readonly ImageModelOption[];
  saveFolderLabel?: string;
  revealLabel: string;
  actions?: readonly ViewerAction[];
  onSave(): void;
  onCopy(): void;
  onReveal(): void;
  formatTime?: (timestamp: number) => string;
}) {
  const rows = detailRows(item, models, formatTime);
  return (
    <aside aria-label="Image details" className="image-viewer-panel flex flex-col gap-4">
      <Text variant="small-strong" color="secondary">{positionLabel(index, count)}</Text>
      {item.prompt ? <ViewerPrompt key={item.assetId} prompt={item.prompt} /> : null}
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button key={action.id} size="small" variant="filled" onClick={() => action.onSelect(item)}>
            {action.icon}
            {action.label}
          </Button>
        ))}
        <Button size="small" variant="muted" onClick={onSave}>
          <Download aria-hidden="true" />
          Save…
        </Button>
        <Button size="small" variant="muted" onClick={onCopy}>
          <Copy aria-hidden="true" />
          Copy Image
        </Button>
        <Button size="small" variant="muted" onClick={onReveal}>
          <FolderOpen aria-hidden="true" />
          {revealLabel}
        </Button>
      </div>
      <Text variant="small" color="secondary" className="flex items-start gap-1.5">
        {item.saved ? <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /> : null}
        {item.saved
          ? saveFolderLabel ? `Saved to ${saveFolderLabel}` : "Saved"
          : "Not saved to your images folder yet"}
      </Text>
      <section aria-label="Details" className="flex flex-col gap-1">
        <Text variant="small" color="secondary">Details</Text>
        <dl className="image-viewer-details">
          {rows.map((row) => (
            <React.Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
    </aside>
  );
}

/**
 * The strip of thumbnails under the stage, centred on the active image. One tab stop: the
 * active thumbnail; ← and → (handled by the viewer) move it, and focus follows.
 */
export function ViewerFilmstrip({
  items,
  index,
  onSelect,
}: {
  items: readonly GalleryItem[];
  index: number;
  onSelect(index: number): void;
}) {
  const list = React.useRef<HTMLUListElement>(null);
  const { start, end } = filmstripWindow(index, items.length, FILMSTRIP_SIZE);
  React.useEffect(() => {
    const element = list.current;
    if (!element || typeof document === "undefined" || !element.contains(document.activeElement)) return;
    element.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
  }, [index]);
  if (items.length < 2) return null;
  return (
    <ul ref={list} aria-label="Images" className="image-viewer-filmstrip">
      {items.slice(start, end).map((item, offset) => {
        const position = start + offset;
        const active = position === index;
        return (
          <li key={item.assetId}>
            <button
              type="button"
              aria-label={`Image ${positionLabel(position, items.length)}`}
              aria-current={active ? "true" : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(position)}
            >
              {item.thumbUrl ? <img src={item.thumbUrl} alt="" draggable={false} /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
