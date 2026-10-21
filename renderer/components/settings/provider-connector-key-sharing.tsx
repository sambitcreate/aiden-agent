// Settings → Providers: whether custom connectors may use this provider's saved
// API key. Off by default; only shown for a saved API key, never for a sign-in
// or subscription credential (main refuses those too).

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field, Switch, toast } from "../ui";
import { providersApi } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
import type { Provider } from "../../lib/types";

export function providerKeyShareable(provider: Pick<Provider, "isBuiltin" | "hasKey" | "credentialType">): boolean {
  return provider.isBuiltin === true && provider.hasKey && provider.credentialType === "api_key";
}

export function ProviderConnectorKeySharing({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const [allowed, setAllowed] = React.useState(provider.connectorKeySharing === true);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setAllowed(provider.connectorKeySharing === true), [provider.connectorKeySharing]);
  if (!providerKeyShareable(provider)) return null;

  const change = async (next: boolean) => {
    setBusy(true);
    try {
      const result = await providersApi.setConnectorKeySharing(provider.id, next);
      setAllowed(result.connectorKeySharing);
      await queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field
      label="Let custom connectors use this key"
      description="Off by default. Each custom connector still needs your approval in Settings → Connectors on this device."
    >
      <Switch
        aria-label={`Let custom connectors use the ${provider.label} key`}
        checked={allowed}
        disabled={busy}
        aria-busy={busy || undefined}
        onCheckedChange={(next) => void change(next)}
      />
    </Field>
  );
}
