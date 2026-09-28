// Quiet, content-free facts about one settled assistant turn: how long it took,
// which model answered, and the provider-reported token totals when known.

import type { TurnFooterItem } from "../shared/assistant-turn-stats";

export function TurnFooter({ items }: { items: readonly TurnFooterItem[] }) {
  if (items.length === 0) return null;
  const description = items.map((item) => item.description).join(", ");
  return (
    <p
      className="turn-footer flex min-w-0 items-center gap-1.5 text-mini text-tertiary tabular-nums"
      data-turn-footer="true"
      title={description}
    >
      <span className="sr-only">{`Response details: ${description}.`}</span>
      {items.map((item, index) => (
        <span
          key={item.kind}
          aria-hidden="true"
          data-turn-footer-item={item.kind}
          className={
            item.kind === "model"
              ? "flex min-w-0 items-center gap-1.5"
              : "flex shrink-0 items-center gap-1.5"
          }
        >
          {index > 0 ? <span>·</span> : null}
          <span className={item.kind === "model" ? "min-w-0 truncate" : undefined}>{item.text}</span>
        </span>
      ))}
    </p>
  );
}
