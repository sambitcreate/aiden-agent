// Web Search settings — Exa API key + enable toggle. When enabled, the assistant
// gets a `web_search` tool.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Field, FieldSet, Input, Switch, toast } from "../ui";
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
    const value = keyDraft.trim();
    await exaApi.setKey(value);
    setKeyDraft("");
    await invalidate();
    toast.success(value ? "Exa API key saved." : "Exa API key removed and web search disabled.");
  };

  const toggle = async (value: boolean) => {
    await exaApi.setEnabled(value);
    await invalidate();
  };

  return (
    <FieldSet title="Web Search (Exa)">
      <Field
        label="Enable web search"
        description={hasKey ? "Adds an Exa search tool. Search queries are sent to Exa when the assistant uses it." : "Add an Exa API key below before enabling search."}
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
          <Button size="medium" variant={!keyDraft.trim() && hasKey ? "destructive" : "filled"} onClick={saveKey} disabled={!keyDraft.trim() && !hasKey}>
            {keyDraft.trim() ? (hasKey ? "Replace" : "Save") : "Remove"}
          </Button>
        </div>
      </Field>
    </FieldSet>
  );
}
