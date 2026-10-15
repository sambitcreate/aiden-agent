// Env variables and headers for a custom MCP server. Saved values live in the
// keychain and never come back to Settings: a saved value shows as dots with
// Replace, and the record keeps its opaque marker until it is replaced.

import { Plus, X } from "lucide-react";
import { Button, Input, Text } from "../ui";
import { isMcpFieldSecretMarker } from "../../shared/mcp-field-secrets";

export interface McpSecretFieldDraft {
  /** Stable React key; not saved. */
  key: string;
  name: string;
  /** A saved marker while `saved`, otherwise the value being typed. */
  value: string;
  saved: boolean;
  /** Written in config.json as plain text (not yet in the keychain): shown, so it can be reviewed. */
  visible?: boolean;
}

let nextKey = 0;
const freshKey = () => `field-${++nextKey}`;

/**
 * A keychain value arrives as its marker and stays masked. A value still
 * written in config.json (a local server added outside Aiden and not yet
 * approved) is shown as written, because saving from the editor approves it.
 */
export function mcpSecretFieldDrafts(record: Record<string, string> | undefined): McpSecretFieldDraft[] {
  return Object.entries(record ?? {}).map(([name, value]) =>
    isMcpFieldSecretMarker(value)
      ? { key: freshKey(), name, value, saved: true }
      : { key: freshKey(), name, value, saved: false, visible: true });
}

/** Rows without a name are dropped; a later duplicate name wins, as it did for KEY=VALUE lines. */
export function mcpSecretFieldRecord(fields: readonly McpSecretFieldDraft[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const field of fields) {
    const name = field.name.trim();
    if (name) record[name] = field.saved || field.visible ? field.value : field.value.trim();
  }
  return record;
}

export function McpSecretFields({
  kind,
  fields,
  onChange,
  disabled,
}: {
  kind: "env" | "headers";
  fields: readonly McpSecretFieldDraft[];
  onChange: (fields: McpSecretFieldDraft[]) => void;
  disabled?: boolean;
}) {
  const noun = kind === "env" ? "variable" : "header";
  const update = (key: string, patch: Partial<McpSecretFieldDraft>) =>
    onChange(fields.map((field) => (field.key === key ? { ...field, ...patch } : field)));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {fields.map((field) => {
        const label = field.name.trim() || `new ${noun}`;
        return (
          <div key={field.key} className="flex min-w-0 items-center gap-2">
            <Input
              aria-label={`${kind === "env" ? "Variable" : "Header"} name`}
              className="min-w-0 flex-1 font-mono"
              value={field.name}
              disabled={disabled}
              spellCheck={false}
              placeholder={kind === "env" ? "API_KEY" : "Authorization"}
              onChange={(event) => update(field.key, { name: event.target.value })}
            />
            {field.saved ? (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Text variant="small" color="secondary" className="min-w-0 flex-1">
                  <span aria-hidden="true">••••••••</span>
                  <span className="sr-only">Saved value of {label}</span>
                </Text>
                <Button
                  variant="transparent"
                  size="small"
                  disabled={disabled}
                  aria-label={`Replace value of ${label}`}
                  onClick={() => update(field.key, { saved: false, value: "" })}
                >
                  Replace
                </Button>
              </div>
            ) : (
              <Input
                aria-label={`Value of ${label}`}
                className="min-w-0 flex-1 font-mono"
                type={field.visible ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={field.value}
                disabled={disabled}
                placeholder={kind === "env" ? "Value" : "Bearer …"}
                onChange={(event) => update(field.key, { value: event.target.value })}
              />
            )}
            <Button
              variant="transparent"
              size="small"
              iconOnly
              disabled={disabled}
              aria-label={`Remove ${label}`}
              onClick={() => onChange(fields.filter((entry) => entry.key !== field.key))}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}
      <Button
        variant="transparent"
        size="small"
        className="self-start"
        disabled={disabled}
        onClick={() => onChange([...fields, { key: freshKey(), name: "", value: "", saved: false }])}
      >
        <Plus className="size-4" />
        Add {noun}
      </Button>
    </div>
  );
}
