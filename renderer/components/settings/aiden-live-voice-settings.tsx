import * as React from "react";
import {
  AIDEN_LIVE_SPEEDS,
  AIDEN_LIVE_VOICES,
  type AidenLivePreferences,
  type AidenLiveRibbonColors,
} from "../../shared/aiden-live-settings";
import {
  useAidenLivePreferences,
  type AidenLivePreferencesPatch,
} from "../assistant/use-aiden-live-preferences";
import { Field, FieldSet, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui";

const RIBBON_COLORS: ReadonlyArray<{ id: AidenLiveRibbonColors; label: string }> = [
  { id: "spectrum", label: "Spectrum" },
  { id: "accent", label: "Theme accent" },
];

/** Settings → Voice & Speech → Aiden Live → Voice and look. */
export function AidenLiveVoiceAndLookFields({
  preferences,
  disabled = false,
  onChange,
}: {
  preferences: Pick<AidenLivePreferences, "voice" | "speed" | "ribbonColors">;
  disabled?: boolean;
  onChange(patch: AidenLivePreferencesPatch): void;
}): React.ReactElement {
  return (
    <FieldSet title="Voice and look">
      <Field label="Voice" description="How Live sounds. A new voice starts the next time you start Live.">
        <Select
          value={preferences.voice}
          disabled={disabled}
          onValueChange={(voice) => onChange({ aidenLiveVoice: voice })}
        >
          <SelectTrigger size="small" className="w-48 max-w-full" aria-label="Live voice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AIDEN_LIVE_VOICES.map((voice) => (
              <SelectItem key={voice.id} value={voice.id}>
                {voice.id} · {voice.character}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Speaking speed" description="How fast Live talks. Its voice keeps the same pitch.">
        <Select
          value={String(preferences.speed)}
          disabled={disabled}
          onValueChange={(speed) => onChange({ aidenLiveSpeed: Number(speed) })}
        >
          <SelectTrigger size="small" className="w-48 max-w-full" aria-label="Live speaking speed">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AIDEN_LIVE_SPEEDS.map((speed) => (
              <SelectItem key={speed} value={String(speed)}>
                {speed === 1 ? "1× (normal)" : `${speed}×`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Ribbon colours" description="The colours of the moving ribbon while Live runs.">
        <Select
          value={preferences.ribbonColors}
          disabled={disabled}
          onValueChange={(colors) => onChange({ aidenLiveRibbonColors: colors as AidenLiveRibbonColors })}
        >
          <SelectTrigger size="small" className="w-48 max-w-full" aria-label="Live ribbon colours">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RIBBON_COLORS.map((colors) => (
              <SelectItem key={colors.id} value={colors.id}>
                {colors.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FieldSet>
  );
}

export function AidenLiveVoiceAndLook(): React.ReactElement {
  const { preferences, loaded, save } = useAidenLivePreferences();
  return (
    <AidenLiveVoiceAndLookFields preferences={preferences} disabled={!loaded} onChange={(patch) => void save(patch)} />
  );
}
