import * as React from "react";
import { Button, Field, FieldSet, Input, Text } from "../ui";
import { DEFAULT_COMPACTION_KEEP_RECENT_TOKENS, DEFAULT_COMPACTION_RESERVE_TOKENS, parseCompactionModelOverrides, type CompactionModelOverrides } from "../../shared/compaction";

export function CompactionBudgetSettings({ overrides, modelKeys, disabled, onSave }: {
  overrides: CompactionModelOverrides;
  modelKeys: readonly string[];
  disabled: boolean;
  onSave: (modelKey: string, budget: CompactionModelOverrides[string] | undefined) => Promise<void>;
}) {
  const listId = React.useId();
  const [modelKey, setModelKey] = React.useState("");
  const [reserve, setReserve] = React.useState("");
  const [recent, setRecent] = React.useState("");
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const savingRef = React.useRef(false);
  const suggestions = React.useMemo(() => [...new Set([...Object.keys(overrides), ...modelKeys])], [overrides, modelKeys]);
  const choose = (key: string) => {
    setModelKey(key);
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      setReserve(overrides[key]?.reserveTokens?.toString() ?? "");
      setRecent(overrides[key]?.keepRecentTokens?.toString() ?? "");
    }
    setError(undefined);
  };
  const save = async (reset: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const key = modelKey.trim();
      const budget = {
        ...(reserve.trim() ? { reserveTokens: Number(reserve) } : {}),
        ...(recent.trim() ? { keepRecentTokens: Number(recent) } : {}),
      };
      parseCompactionModelOverrides({ [key]: reset ? {} : budget });
      await onSave(key, reset || Object.keys(budget).length === 0 ? undefined : budget);
      if (reset) { setReserve(""); setRecent(""); }
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save model budgets.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <FieldSet title="Model compaction budgets">
      <Field label="Model" description="Choose or enter an exact provider/model. Models with no override keep automatic defaults.">
        <Input aria-label="Model for compaction budget" list={listId} value={modelKey} onChange={(event) => choose(event.target.value)} placeholder="openai/gpt-6-sol" disabled={disabled || saving} />
        <datalist id={listId}>{suggestions.map((key) => <option key={key} value={key} />)}</datalist>
      </Field>
      <Field label="Reserved tokens" description={`Space for the compaction summary. Leave blank for ${DEFAULT_COMPACTION_RESERVE_TOKENS.toLocaleString("en-US")} tokens.`}>
        <Input aria-label="Compaction reserved tokens" type="number" min={2} max={10000000} step={1} placeholder={String(DEFAULT_COMPACTION_RESERVE_TOKENS)} value={reserve} onChange={(event) => setReserve(event.target.value)} disabled={disabled || saving} />
      </Field>
      <Field label="Recent tokens" description={`Recent conversation to retain. Leave blank for ${DEFAULT_COMPACTION_KEEP_RECENT_TOKENS.toLocaleString("en-US")} tokens; zero allows summarizing all older context.`}>
        <Input aria-label="Compaction recent tokens" type="number" min={0} max={10000000} step={1} placeholder={String(DEFAULT_COMPACTION_KEEP_RECENT_TOKENS)} value={recent} onChange={(event) => setRecent(event.target.value)} disabled={disabled || saving} />
      </Field>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Text as="p" variant="small" color="secondary">Applies to new runs and manual compaction, including subagents using this model. Budgets are reduced to fit small model windows. Request safety reserves still apply.</Text>
        {error ? <Text as="p" variant="small" color="status-red" role="alert">{error}</Text> : null}
        <div className="flex justify-end gap-2">
          <Button variant="muted" disabled={disabled || saving || !modelKey.trim()} onClick={() => void save(true)}>Reset model</Button>
          <Button disabled={disabled || saving || !modelKey.trim()} onClick={() => void save(false)}>{saving ? "Saving…" : "Save budget"}</Button>
        </div>
        {Object.keys(overrides).length ? <div className="flex flex-wrap gap-2" aria-label="Saved model budgets">
          {Object.keys(overrides).map((key) => <Button key={key} variant="muted" className="max-w-full" disabled={disabled || saving} onClick={() => choose(key)}><span className="truncate">{key}</span></Button>)}
        </div> : null}
      </div>
    </FieldSet>
  );
}
