import * as React from "react";
import { providersApi } from "../lib/ipc";
import { discoveredDefaultModel, localProviderDraft } from "../lib/onboarding-provider";
import type { Provider } from "../lib/types";
import { mergeDiscoveredModelMetadata } from "../shared/custom-model-options";
import { Button, Dialog, Text, type DialogLayer } from "./ui";

type Runtime = "lmstudio" | "ollama";
export function LocalProviderDialog({
  runtime,
  layer,
  onEdit,
  onSaved,
  onClose,
  returnFocus,
}: {
  returnFocus: () => HTMLElement | null;
  runtime: Runtime;
  layer?: DialogLayer;
  onEdit: () => void;
  onSaved: (provider: Provider) => Promise<void>;
  onClose: () => void;
}) {
  const label = runtime === "lmstudio" ? "LM Studio" : "Ollama";
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const pending = React.useRef(false);
  const check = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const current = await providersApi.list();
      const draft = localProviderDraft(runtime, current);
      const found = await providersApi.test(draft).catch((cause: unknown) => {
        throw new Error(
          `Couldn’t reach ${label}. Check the server address and that the server is running. ${cause instanceof Error ? cause.message : ""}`,
        );
      });
      const model = discoveredDefaultModel(draft, found);
      if (!model)
        throw new Error(
          "Server reached, but no chat models were found. Load a model in your server, then try again.",
        );
      const previous = draft.modelMetadata ?? {};
      const manual = draft.models.filter((id) => previous[id]?.manuallyAdded);
      const models = [...new Set([...found.models, ...manual])];
      const modelMetadata = mergeDiscoveredModelMetadata(
        {
          ...Object.fromEntries(manual.map((id) => [id, previous[id]!])),
          ...found.modelMetadata,
        },
        previous,
      );
      const saved = await providersApi.save({ ...draft, models, modelMetadata, defaultModel: model });
      await onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t connect to the local server.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      layer={layer}
      returnFocus={returnFocus}
      title={`Connect ${label}`}
      description={`Start ${label}, enable its server and load a chat model.`}
      confirmLabel={busy ? "Checking…" : "Check for models"}
      busy={busy}
      dismissDisabled={busy}
      confirmDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
      onConfirm={check}
    >
      {error && (
        <Text as="p" variant="small" color="red" role="alert">
          {error}
        </Text>
      )}
      <details className="settings-card">
        <summary className="cursor-pointer px-4 py-3 text-small-strong">Advanced</summary>
        <div className="px-4 pb-3">
          <Button variant="filled" size="small" disabled={busy} onClick={onEdit}>
            Edit server address and options
          </Button>
        </div>
      </details>
    </Dialog>
  );
}
