import { useId } from "react";
import { Field, Input } from "../ui";
import { parseMcpOAuthMetadataUrl } from "../../shared/mcp-oauth-config.js";

export function mcpOAuthMetadataFieldError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try { parseMcpOAuthMetadataUrl(value.trim()); return undefined; }
  catch (error) { return error instanceof Error ? error.message : "Invalid OAuth metadata URL."; }
}

export function McpOAuthMetadataField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const id = useId();
  const error = mcpOAuthMetadataFieldError(value);
  return <Field label="Authorization metadata URL" orientation="vertical"
    description="Optional. Use the metadata address provided by your server administrator when automatic sign-in discovery fails. Changing it requires signing in again.">
    <Input aria-label="Authorization metadata URL" aria-invalid={Boolean(error)} aria-describedby={error ? id : undefined}
      type="url" maxLength={2048} value={value} onChange={(event) => onChange(event.target.value)}
      placeholder="Automatic discovery" />
    {error ? <p id={id} role="alert" className="text-small text-support-red">{error}</p> : null}
  </Field>;
}
