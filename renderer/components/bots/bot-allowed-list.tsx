import { Button, Field } from "../ui";
import type { BotAllowedEntry } from "../../shared/tool-approval-scope";

function entryDescription(entry: BotAllowedEntry): string {
  const date = new Date(entry.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const added = `Added ${date}`;
  return entry.kind === "folder" ? added : `${added} · ${entry.uses === 0 ? "Not used yet" : `Used ${entry.uses} ${entry.uses === 1 ? "time" : "times"}`}`;
}

/** Rows share the surrounding FieldSet's card and inset separators. */
export function BotAllowedList({ entries, onRemove, removing }: {
  entries: BotAllowedEntry[];
  onRemove(entry: BotAllowedEntry): void;
  removing?: string;
}) {
  return <>{entries.map((entry) => (
    <Field key={`${entry.botId}:${entry.id}`} label={<span className="select-text [overflow-wrap:anywhere]">{entry.what}</span>} description={entryDescription(entry)}>
      <Button size="small" variant="transparent" disabled={entry.id === removing} onClick={() => onRemove(entry)}>Remove</Button>
    </Field>
  ))}</>;
}
