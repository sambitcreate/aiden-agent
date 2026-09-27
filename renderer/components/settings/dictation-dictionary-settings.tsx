// Custom dictation dictionary: words the recognizer should spell a specific
// way ("aiden" -> "Aiden") and phrase replacements. Applied to every finished
// transcript, from the global shortcut and the composer microphone alike.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Button, Field, FieldSet, Input, Text, toast } from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import {
  addDictationDictionaryEntry,
  parseDictationDictionary,
  type DictationDictionaryEntry,
} from "../../shared/dictation-dictionary";

// One dictionary editor exists per Settings page, so a fixed id is unique.
const errorId = "dictation-dictionary-error";

export interface DictationDictionaryViewProps {
  entries: readonly DictationDictionaryEntry[];
  heard: string;
  replacement: string;
  error: string | null;
  saving: boolean;
  onHeardChange: (value: string) => void;
  onReplacementChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

export function DictationDictionaryView({
  entries,
  heard,
  replacement,
  error,
  saving,
  onHeardChange,
  onReplacementChange,
  onAdd,
  onRemove,
}: DictationDictionaryViewProps) {
  return (
    <FieldSet title="Custom Dictionary">
      <Field
        label="Words and replacements"
        description="Fix names and terms dictation often gets wrong. Matches whole words, ignoring case. Leave “Replace with” empty to keep the word exactly as you typed it. Re-adding a word updates it."
        orientation="vertical"
      >
        <form
          className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <Input
            aria-label="Heard as"
            placeholder="Heard as, e.g. aiden"
            value={heard}
            maxLength={100}
            disabled={saving}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onHeardChange(event.currentTarget.value)}
          />
          <Input
            aria-label="Replace with"
            placeholder="Replace with, e.g. Aiden"
            value={replacement}
            maxLength={100}
            disabled={saving}
            onChange={(event) => onReplacementChange(event.currentTarget.value)}
          />
          <Button type="submit" size="small" variant="filled" disabled={saving || !heard.trim()}>
            <Plus className="size-4" />
            Add
          </Button>
        </form>
        {error ? (
          <Text id={errorId} as="p" variant="small" color="red" role="alert" className="mt-2">
            {error}
          </Text>
        ) : null}
        {entries.length === 0 ? (
          <Text as="p" variant="small" color="secondary" className="mt-3">
            No custom words yet.
          </Text>
        ) : (
          <ul className="mt-3 flex flex-col gap-1" aria-label="Custom dictionary">
            {entries.map((entry, index) => (
              <li
                key={entry.from.toLowerCase()}
                className="flex min-w-0 items-center gap-2 rounded-control px-2 py-1 hover:bg-list-hover"
              >
                <Text variant="small" className="min-w-0 truncate">
                  {entry.from}
                </Text>
                {entry.to ? (
                  <>
                    <ArrowRight aria-hidden className="size-3.5 shrink-0 text-tertiary" />
                    <Text variant="small-strong" className="min-w-0 truncate">
                      {entry.to}
                    </Text>
                  </>
                ) : (
                  <Text variant="small" color="tertiary" className="shrink-0">
                    exact spelling
                  </Text>
                )}
                <Button
                  className="ml-auto shrink-0"
                  variant="transparent"
                  size="small"
                  iconOnly
                  disabled={saving}
                  aria-label={`Remove ${entry.from}`}
                  onClick={() => onRemove(index)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Field>
    </FieldSet>
  );
}

export function DictationDictionarySettings() {
  const qc = useQueryClient();
  const settings = useSettings();
  const entries = React.useMemo(
    () => parseDictationDictionary(settings.data?.dictationDictionary),
    [settings.data?.dictationDictionary],
  );
  const [heard, setHeard] = React.useState("");
  const [replacement, setReplacement] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const save = async (next: DictationDictionaryEntry[]): Promise<boolean> => {
    setSaving(true);
    try {
      await settingsApi.set({ dictationDictionary: next });
      await qc.invalidateQueries({ queryKey: queryKeys.settings });
      return true;
    } catch {
      toast.error("Aiden couldn’t save the custom dictionary.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async () => {
    const edit = addDictationDictionaryEntry(entries, heard, replacement);
    if (!edit.ok) {
      setError(edit.error);
      return;
    }
    setError(null);
    if (await save(edit.entries)) {
      setHeard("");
      setReplacement("");
    }
  };

  return (
    <DictationDictionaryView
      entries={entries}
      heard={heard}
      replacement={replacement}
      error={error}
      saving={saving}
      onHeardChange={(value) => {
        setHeard(value);
        setError(null);
      }}
      onReplacementChange={setReplacement}
      onAdd={() => void add()}
      onRemove={(index) => void save(entries.filter((_, position) => position !== index))}
    />
  );
}
