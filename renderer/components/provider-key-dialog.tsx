import * as React from "react";
import { providersApi } from "../lib/ipc";
import type { Provider } from "../lib/types";
import { Dialog, Field, Input, Text, toast, type DialogLayer } from "./ui";

export function ProviderKeyDialog({
  id,
  layer,
  onSaved,
  onClose,
  returnFocus,
}: {
  returnFocus: () => HTMLElement | null;
  id: "openai" | "anthropic";
  layer?: DialogLayer;
  onSaved: (provider: Provider) => Promise<void>;
  onClose: () => void;
}) {
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef(false);
  const [error, setError] = React.useState("");
  const validate = async () => {
    if (!key.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await providersApi.validateOnboardingApiKey(id, key.trim());
      setKey("");
      await onSaved(result.provider);
      if (result.catalogWarning) toast.warning(result.catalogWarning);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t validate the API key.");
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
      title={`Connect ${id === "openai" ? "OpenAI" : "Anthropic"}`}
      description="Your provider bills API usage. Aiden checks the key without sending a chat message and stores accepted keys encrypted on this device."
      confirmLabel={busy ? "Validating…" : "Validate key"}
      confirmDisabled={!key.trim() || busy}
      dismissDisabled={busy}
      busy={busy}
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
      onConfirm={validate}
    >
      <Field label="API key">
        <Input
          autoFocus
          type="password"
          autoComplete="off"
          placeholder="Paste your API key"
          disabled={busy}
          value={key}
          aria-invalid={Boolean(error)}
          onChange={(e) => {
            setKey(e.target.value);
            setError("");
          }}
        />
      </Field>
      {error && (
        <Text as="p" variant="small" color="red" role="alert">
          {error}
        </Text>
      )}
    </Dialog>
  );
}
