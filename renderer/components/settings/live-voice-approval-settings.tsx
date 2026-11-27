import * as React from "react";
import { useSettings } from "../../lib/queries";
import { useSettingsSave } from "../../lib/use-settings-save";
import { aidenLivePreferences } from "../../shared/aiden-live-settings";
import { LIVE_VOICE_LANGUAGES, liveVoicePhrases } from "../../shared/live-voice-phrases";
import { Field, FieldSet, SettingsDisclosure, Switch, Text } from "../ui";

/** "English, Spanish … and Chinese". */
export function liveVoiceLanguageList(): string {
  const names = LIVE_VOICE_LANGUAGES.map((language) => language.name);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

function quoted(phrases: readonly string[]): string {
  return phrases.map((phrase) => `“${phrase}”`).join(", ");
}

/** What to say, per language, so nobody has to guess the phrases. */
export function LiveVoicePhraseList(): React.ReactElement {
  return (
    <SettingsDisclosure
      title="What to say"
      summary={`Allow and deny phrases in ${LIVE_VOICE_LANGUAGES.length} languages`}
    >
      {LIVE_VOICE_LANGUAGES.map((language) => (
        <Field key={language.code} label={language.name} orientation="vertical">
          <div className="flex flex-col gap-1" lang={language.code}>
            <Text as="p" variant="small" color="secondary">
              <span className="text-primary">Allow once: </span>
              {quoted(liveVoicePhrases(language.code, "allow"))}
            </Text>
            <Text as="p" variant="small" color="secondary">
              <span className="text-primary">Deny: </span>
              {quoted(liveVoicePhrases(language.code, "deny"))}
            </Text>
          </div>
        </Field>
      ))}
    </SettingsDisclosure>
  );
}

/** Settings → Aiden Live → Answer approvals by voice. */
export function LiveVoiceApprovalSettings(): React.ReactElement {
  const settings = useSettings();
  const { saving, save } = useSettingsSave({ guard: "state" });
  const enabled = aidenLivePreferences(settings.data).voiceApprovals;
  return (
    <>
      <FieldSet title="Approvals">
        <Field
          label="Answer approvals by voice"
          description={
            <>
              When the chat on screen asks to run or change something, Live reads it out and you
              can say allow or deny. Voice allows once only; passwords, payments and similar
              requests still need a tap.
              <span className="mt-1 block">Works in {liveVoiceLanguageList()}.</span>
            </>
          }
        >
          <Switch
            aria-label="Answer approvals by voice"
            checked={enabled}
            disabled={settings.isLoading || saving}
            onCheckedChange={(checked) =>
              void save({ aidenLiveVoiceApprovals: checked }, "Couldn’t update Aiden Live settings.")
            }
          />
        </Field>
      </FieldSet>
      {enabled ? <LiveVoicePhraseList /> : null}
    </>
  );
}
