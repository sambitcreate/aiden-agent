import { Button, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Text } from "../ui";
import { InfoHint } from "../ui-info-hint";
import type { Provider } from "../../lib/types";

/**
 * Providers whose key a custom connector may use: built-in providers with a
 * saved API key that were opted in from Settings → Providers. Sign-in and
 * subscription credentials never qualify. The selected provider stays listed
 * so its sharing can be stopped.
 */
export function mcpShareableProviders(providers: readonly Provider[], selectedId: string): Provider[] {
  return providers.filter(
    (provider) =>
      provider.isBuiltin === true &&
      ((provider.hasKey && provider.credentialType === "api_key" && provider.connectorKeySharing === true) ||
        provider.id === selectedId),
  );
}

export function McpProviderAuthFields(props: {
  providerId: string; endpoint: string; approved: boolean; busy: boolean; disabled: boolean;
  providers: readonly { id: string; label: string }[];
  onProviderChange(id: string): void; onConsent(allowed: boolean): void;
}) {
  return <>
    <Field
      label={<span className="inline-flex items-center gap-1.5">Provider API key<InfoHint topic="sharing a provider API key">
        <p>Sends a built-in provider’s saved API key to this server as a bearer token. Sign-in and subscription credentials are never shared.</p>
        <p>Turn on “Let custom connectors use this key” for the provider in Settings → Providers first.</p>
      </InfoHint></span>}
      description="Optional. Can’t be combined with OAuth or custom headers."
    >
      {props.providers.length === 0 && !props.providerId ? (
        <Text variant="small" color="secondary">No provider keys are shared with connectors.</Text>
      ) : (
        <Select value={props.providerId || "none"} onValueChange={(id) => props.onProviderChange(id === "none" ? "" : id)}>
          <SelectTrigger aria-label="Provider API key"><SelectValue placeholder="Do not share" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Do not share</SelectItem>
            {props.providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </Field>
    {props.providerId ? <Field label="Key sharing" orientation="vertical"
      description="Only attended desktop workspace chats can use this connection. Imported settings can’t approve it; each device needs your approval.">
      <p className="break-all text-small text-secondary">Allow this server to receive the selected provider’s API key on every request: <strong>{props.endpoint || "Add an HTTPS server URL"}</strong></p>
      <Button size="small" variant="filled" disabled={props.disabled || props.busy} onClick={() => props.onConsent(!props.approved)}>
        {props.busy ? "Updating…" : props.approved ? "Stop sharing the key" : "Allow the key"}
      </Button>
      <p role="status" className="text-small text-secondary">{props.approved ? "Approved on this device." : "Not approved on this device. Saving the server does not grant access."}</p>
    </Field> : null}
  </>;
}
