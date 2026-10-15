// Browser sign-in controls for OAuth MCP servers: Authorize, Cancel while the
// browser is open, Sign out, and a "Needs sign-in" state when stored tokens
// stopped working. Shared by custom servers and OAuth presets.

import { ShieldCheck } from "lucide-react";
import { Badge, Button, Text } from "../ui";
/** Authorize / Cancel / Sign out, shared by custom servers and OAuth presets. */
export function McpSignInControls({
  authorizing,
  authorized,
  needsSignIn,
  signingOut,
  disabled,
  onAuthorize,
  onCancel,
  onSignOut,
}: {
  authorizing: boolean;
  authorized: boolean;
  needsSignIn: boolean;
  signingOut: boolean;
  disabled: boolean;
  onAuthorize: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {authorizing ? (
        <>
          <Text variant="small" color="secondary" aria-live="polite">
            Waiting for browser…
          </Text>
          <Button size="small" variant="filled" onClick={onCancel}>
            Cancel sign-in
          </Button>
        </>
      ) : (
        <Button size="small" variant="filled" onClick={onAuthorize} disabled={disabled || signingOut}>
          {needsSignIn ? "Sign in again" : authorized ? "Re-authorize" : "Authorize"}
        </Button>
      )}
      {!authorizing && needsSignIn ? <Badge color="warning">Needs sign-in</Badge> : null}
      {!authorizing && authorized && !needsSignIn ? (
        <span className="flex items-center gap-1 text-small text-support-green">
          <ShieldCheck className="size-4" />
          Authorized
        </span>
      ) : null}
      {!authorizing && (authorized || needsSignIn) ? (
        <Button size="small" variant="transparent" onClick={onSignOut} disabled={signingOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      ) : null}
    </div>
  );
}
