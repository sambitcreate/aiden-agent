import { Button, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui";

export function McpProviderAuthFields(props: {
  providerId: string; endpoint: string; approved: boolean; busy: boolean; disabled: boolean;
  providers: readonly { id: string; label: string }[];
  onProviderChange(id: string): void; onConsent(allowed: boolean): void;
}) {
  return <>
    <Field label="Provider credential" description="Optional. Share a built-in provider’s saved sign-in or API key with this custom HTTP server. OAuth and custom headers cannot be combined with this mode.">
      <Select value={props.providerId || "none"} onValueChange={(id) => props.onProviderChange(id === "none" ? "" : id)}>
        <SelectTrigger aria-label="MCP authentication provider"><SelectValue placeholder="Do not share" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Do not share</SelectItem>
          {props.providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
    {props.providerId ? <Field label="Credential sharing" orientation="vertical"
      description="Only attended desktop workspace chats can use this connection. Imported settings cannot approve credential sharing; each device needs your approval.">
      <p className="break-all text-small text-secondary">Allow this server to receive your selected provider’s current bearer credential on every request: <strong>{props.endpoint || "Add an HTTPS server URL"}</strong></p>
      <Button size="small" variant="filled" disabled={props.disabled || props.busy} onClick={() => props.onConsent(!props.approved)}>
        {props.busy ? "Updating…" : props.approved ? "Stop sharing credential" : "Allow provider credential"}
      </Button>
      <p role="status" className="text-small text-secondary">{props.approved ? "Approved on this device." : "Not approved on this device. Saving the server does not grant access."}</p>
    </Field> : null}
  </>;
}
