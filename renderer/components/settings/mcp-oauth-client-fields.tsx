// A pre-registered OAuth client for a custom MCP server whose provider does
// not support dynamic client registration. The secret follows the env/header
// pattern: once saved it lives in the keychain and comes back only as a
// marker, shown as dots with Replace.

import { Button, Field, Input, Text } from "../ui";
import { isMcpFieldSecretMarker } from "../../shared/mcp-field-secrets";
import { MCP_OAUTH_REDIRECT_URI } from "../../shared/mcp-oauth-config.js";

export interface McpOAuthClientSecretDraft {
  /** The saved marker while `saved`, otherwise the value being typed. */
  value: string;
  saved: boolean;
}

export function mcpOAuthClientSecretDraft(value: string | undefined): McpOAuthClientSecretDraft {
  return value !== undefined && isMcpFieldSecretMarker(value) ? { value, saved: true } : { value: value ?? "", saved: false };
}

/** The record's `oauthClientSecret`: the kept marker, the typed value, or nothing without a client ID. */
export function mcpOAuthClientSecretValue(clientId: string, secret: McpOAuthClientSecretDraft): string | undefined {
  if (!clientId.trim()) return undefined;
  return secret.saved ? secret.value : secret.value || undefined;
}

export function McpOAuthClientFields({
  clientId,
  secret,
  onClientIdChange,
  onSecretChange,
}: {
  clientId: string;
  secret: McpOAuthClientSecretDraft;
  onClientIdChange(value: string): void;
  onSecretChange(value: McpOAuthClientSecretDraft): void;
}) {
  return (
    <>
      <Field
        label="OAuth client ID"
        orientation="vertical"
        description={`Optional, for servers that don’t register apps automatically. Register an app with the provider using the redirect URI ${MCP_OAUTH_REDIRECT_URI}, then enter its client ID. Changing it requires signing in again.`}
      >
        <Input
          aria-label="OAuth client ID"
          maxLength={256}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={clientId}
          onChange={(event) => onClientIdChange(event.target.value)}
          placeholder="Register automatically"
        />
      </Field>
      {clientId.trim() ? (
        <Field
          label="OAuth client secret"
          orientation="vertical"
          description="Only if the provider issued one. Stored encrypted on this device, not in config.json, and never shown again."
        >
          {secret.saved ? (
            <div className="flex min-w-0 items-center gap-2">
              <Text variant="small" color="secondary" className="min-w-0 flex-1">
                <span aria-hidden="true">••••••••</span>
                <span className="sr-only">Saved OAuth client secret</span>
              </Text>
              <Button
                variant="transparent"
                size="small"
                aria-label="Replace OAuth client secret"
                onClick={() => onSecretChange({ value: "", saved: false })}
              >
                Replace
              </Button>
            </div>
          ) : (
            <Input
              aria-label="OAuth client secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              className="font-mono"
              value={secret.value}
              onChange={(event) => onSecretChange({ value: event.target.value, saved: false })}
              placeholder="None"
            />
          )}
        </Field>
      ) : null}
    </>
  );
}
