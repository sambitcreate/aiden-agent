// Providers settings — list preset + custom connections, configure keys/models,
// add custom endpoints, and remove custom providers.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertDialog, Badge, Button, Separator, Text } from "../ui";
import { Plus, Trash2 } from "lucide-react";
import { ProviderEditor } from "./provider-editor";
import { providersApi } from "../../lib/ipc";
import { queryKeys, useProviders } from "../../lib/queries";
import type { Provider } from "../../lib/types";

function statusBadge(p: Provider): React.ReactNode {
  if (!p.needsKey) return <Badge color="blue">Local</Badge>;
  if (p.hasKey) return <Badge color="green">Key set</Badge>;
  return <Badge color="secondary">No key</Badge>;
}

export function ProvidersSettings() {
  const qc = useQueryClient();
  const providers = useProviders();
  const [editing, setEditing] = React.useState<Provider | null>(null);
  const [removing, setRemoving] = React.useState<Provider | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.providers });

  const addCustom = () => {
    const id = `custom-${Date.now().toString(36)}`;
    setEditing({
      id,
      kind: "openai",
      label: "Custom Provider",
      baseUrl: "http://localhost:8000/v1",
      models: [],
      // Custom connections start local-first. The editor exposes an explicit
      // auth toggle for hosted endpoints that require a bearer key.
      needsKey: false,
      isPreset: false,
      hasKey: false,
    });
  };

  const confirmRemove = async () => {
    if (!removing) return;
    await providersApi.remove(removing.id);
    await invalidate();
    setRemoving(null);
  };

  const list = providers.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Text variant="strong">Providers</Text>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Use hosted APIs or local models. Messages and attachments go to the selected provider;
            keys stay encrypted on this Mac.
          </Text>
        </div>
        <Button className="shrink-0" variant="filled" size="small" onClick={addCustom}>
          <Plus className="size-4" />
          Add custom
        </Button>
      </div>

      <div className="rounded-card border border-separator">
        {list.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 ? <Separator /> : null}
            <div className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Text variant="strong" truncate>
                    {p.label}
                  </Text>
                  {statusBadge(p)}
                </div>
                <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                  {p.baseUrl}
                </Text>
              </div>
              <Button variant="filled" size="small" onClick={() => setEditing(p)}>
                Configure
              </Button>
              {!p.isPreset ? (
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label="Remove provider"
                  onClick={() => setRemoving(p)}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
          </React.Fragment>
        ))}
      </div>

      {editing ? (
        <ProviderEditor
          provider={editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={invalidate}
        />
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this provider?"
        description={removing ? `“${removing.label}” and its saved key will be removed.` : null}
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={confirmRemove}
      />
    </div>
  );
}
