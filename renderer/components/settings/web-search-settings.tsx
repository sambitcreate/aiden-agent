// Web Search settings — Exa API key + enable toggle. When enabled, the assistant
// gets a `web_search` tool.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Field, FieldSet, Input, Switch, Text, toast } from "@glaze/core/components";
import { exaApi } from "../../lib/ipc";
import { queryKeys, useExaConfig } from "../../lib/queries";

export function WebSearchSettings() {
  const qc = useQueryClient();
  const exa = useExaConfig();
  const [keyDraft, setKeyDraft] = React.useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.exa });
  const enabled = exa.data?.enabled ?? false;
  const hasKey = exa.data?.hasKey ?? false;

  const saveKey = async () => {
    await exaApi.setKey(keyDraft.trim());
    setKeyDraft("");
    await invalidate();
    toast.success(keyDraft.trim() ? "Exa API key saved." : "Exa API key removed.");
  };

  const toggle = async (value: boolean) => {
    await exaApi.setEnabled(value);
    await invalidate();
  };

  return (
    <FieldSet title="Web Search (Exa)">
      <Field
        label="Enable web search"
        description="Lets the assistant search the web with Exa when it needs current information."
      >
        <Switch checked={enabled} onCheckedChange={toggle} disabled={!hasKey} />
      </Field>
      <Field
        label="Exa API key"
        description={hasKey ? "A key is saved. Enter a new value to replace it." : "Get a key at exa.ai. Stored encrypted on this device."}
      >
        <div className="flex gap-2">
          <Input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={hasKey ? "••••••••••••" : "Paste your Exa API key"}
          />
          <Button size="medium" variant="filled" onClick={saveKey} disabled={!keyDraft.trim() && !hasKey}>
            Save
          </Button>
        </div>
      </Field>
      {!hasKey ? (
        <Text variant="small" color="tertiary">
          Add a key to enable web search.
        </Text>
      ) : null}
    </FieldSet>
  );
}
