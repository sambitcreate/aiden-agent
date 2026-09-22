// On-device voice settings: engine status and the active Parakeet model.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Callout, Field, FieldSet, Text } from "../ui";
import { Settings2 } from "lucide-react";
import { settingsApi } from "../../lib/ipc";
import { queryKeys, useEngineStatus, useLocalModels, useSettings } from "../../lib/queries";
import { ModelManagerView } from "./model-manager-view";

function EngineStatus() {
  const status = useEngineStatus();
  if (status.isLoading) {
    return (
      <Field label="Engine" description="Checking the bundled on-device transcription engine.">
        <Badge>Checking…</Badge>
      </Field>
    );
  }
  if (status.isError || (status.data && !status.data.ready)) {
    return (
      <Callout color="red">
        <Text variant="small-strong" color="red">
          On-device engine unavailable
        </Text>
        <Text variant="small" color="secondary">
          {status.data?.error ?? (status.error instanceof Error ? status.error.message : "The speech engine failed to load.")}
        </Text>
      </Callout>
    );
  }
  return (
    <Field label="Engine" description="Transcription runs locally after you download a Parakeet model.">
      <Badge color="green">Ready</Badge>
    </Field>
  );
}

function ActiveModel({ onManage }: { onManage: () => void }) {
  const qc = useQueryClient();
  const models = useLocalModels();
  const settings = useSettings();
  const activeId = settings.data?.localVoiceModel ?? "";
  const active = (models.data ?? []).find((m) => m.id === activeId && m.installed);
  const installedCount = (models.data ?? []).filter((m) => m.installed).length;

  React.useEffect(() => {
    if (activeId && models.data && !models.data.some((m) => m.id === activeId && m.installed)) {
      void settingsApi.set({ localVoiceModel: "" }).then(() => qc.invalidateQueries({ queryKey: queryKeys.settings }));
    }
  }, [activeId, models.data, qc]);

  return (
    <>
      {installedCount === 0 ? (
        <Callout color="blue">
          <Text variant="small">No on-device models yet. Download one to start transcribing locally.</Text>
        </Callout>
      ) : (
        <Field label="Active model" description="Used when you dictate with the on-device provider.">
          <Text variant="small-strong">{active ? active.name : "None selected"}</Text>
        </Field>
      )}
      <Field label="Models" description="Download, remove, and choose your on-device transcription model.">
        <Button variant="filled" onClick={onManage}>
          <Settings2 />
          Manage Models
        </Button>
      </Field>
    </>
  );
}

export function LocalVoiceSettings() {
  const [managing, setManaging] = React.useState(false);

  if (managing) return <ModelManagerView onBack={() => setManaging(false)} />;

  return (
    <div className="flex flex-col gap-6">
      <FieldSet title="On-Device Engine">
        <EngineStatus />
        <ActiveModel onManage={() => setManaging(true)} />
      </FieldSet>
    </div>
  );
}
