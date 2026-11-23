// Quick Chat preferences card rendered inside Settings → Appearance.
// Follows docs/settings-design-system.md (FieldSet, Field, Select, Switch).

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  toast,
} from "../ui";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useSettings } from "../../lib/queries";
import {
  QUICK_CHAT_DEFAULT_PERSISTENCE_VALUES,
  parseQuickChatDefaultPersistence,
  type QuickChatDefaultPersistence,
} from "../../shared/quick-chat";
import { useOptionalShortcutLabel } from "../../lib/command-system";

const DEFAULT_PERSISTENCE_LABELS: Record<QuickChatDefaultPersistence, string> = {
  ephemeral: "Temporary",
  noWorkspace: "No workspace",
  lastWorkspace: "Last used workspace",
};

export function QuickChatSettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const [saving, setSaving] = React.useState(false);
  const shortcutLabel = useOptionalShortcutLabel("quickChat.toggle");

  const defaultPersistence: QuickChatDefaultPersistence =
    parseQuickChatDefaultPersistence(settings.data?.quickChatDefaultPersistence) ?? "ephemeral";
  const keepOpenOnBlur = settings.data?.quickChatKeepOpenOnBlur !== false;

  const savePatch = async (patch: {
    quickChatDefaultPersistence?: QuickChatDefaultPersistence;
    quickChatKeepOpenOnBlur?: boolean;
  }) => {
    setSaving(true);
    try {
      const saved = await settingsApi.set(patch);
      queryClient.setQueryData(queryKeys.settings, saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save Quick Chat setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldSet title="Quick Chat">
      <Field
        label="Default chat mode"
        description={
          shortcutLabel
            ? `Where new chats opened with ${shortcutLabel} start. Temporary chats stay out of your sidebar until you save or attach them.`
            : "Where new floating Quick Chats start. Temporary chats stay out of your sidebar until you save or attach them."
        }
      >
        <Select
          value={defaultPersistence}
          disabled={settings.isLoading || saving}
          onValueChange={(value) => {
            const parsed = parseQuickChatDefaultPersistence(value);
            if (!parsed || parsed === defaultPersistence) return;
            void savePatch({ quickChatDefaultPersistence: parsed });
          }}
        >
          <SelectTrigger
            size="small"
            className="w-48 max-w-full"
            aria-label="Default Quick Chat mode"
          >
            <SelectValue>{DEFAULT_PERSISTENCE_LABELS[defaultPersistence]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {QUICK_CHAT_DEFAULT_PERSISTENCE_VALUES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {DEFAULT_PERSISTENCE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Keep mini-modal open when clicking outside"
        description="Once you send a message in Quick Chat, keep the floating conversation pinned on screen while you switch to other apps. Press Escape or the close button to hide it."
      >
        <Switch
          checked={keepOpenOnBlur}
          disabled={settings.isLoading || saving}
          onCheckedChange={(checked) => void savePatch({ quickChatKeepOpenOnBlur: checked })}
          aria-label="Keep mini-modal open when clicking outside"
        />
      </Field>
    </FieldSet>
  );
}
