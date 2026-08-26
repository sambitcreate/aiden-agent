import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./remote-access-settings.tsx", import.meta.url), "utf8");

test("Remote Access settings use the existing semantic form and confirmation primitives", () => {
  for (const primitive of ["FieldSet", "Field", "Switch", "Select", "Callout", "Dialog", "AlertDialog"]) {
    assert.match(source, new RegExp(`<${primitive}`, "u"));
  }
  assert.match(source, /onValueChange=/u);
  assert.match(source, /aria-label="Enable Aiden Remote Access"/u);
  assert.match(source, /max-\[540px\]/u);
});

test("pairing offers QR and a distinct IPC-only manual setup code", () => {
  assert.match(source, /QRCode\.toDataURL\(pairing\.qrPayload/u);
  assert.doesNotMatch(source, /\{pairing\.secret\}/u);
  assert.match(source, /\{pairing\.manualCode\}/u);
  assert.match(source, /Copy setup code/u);
  assert.match(source, /Certificate check/u);
  assert.doesNotMatch(source, /manual pairing password/u);
  assert.match(source, /expires after five minutes/u);
  assert.match(source, /evaluateRemotePairingLifecycle/u);
  assert.match(source, /pairingSessionId/u);
  assert.match(source, /connected\.`\)/u);
  assert.match(source, /Finishing connection/u);
  assert.match(source, /data-remote-device-id/u);
  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /pairingRequestGeneration/u);
  assert.match(source, /remotePairingPresentation/u);
  assert.match(source, /effectiveRemotePairingLifecycle/u);
  assert.match(source, /Copy desktop address/u);
  assert.match(source, /Private Tailscale address/u);
  assert.match(source, /Code unavailable/u);
  assert.match(source, /aria-disabled=\{pairingPresentation\.qrDisabled\}/u);
  assert.match(source, /Create new code/u);
  assert.match(source, /Consumed Aiden pairing QR code/u);
  assert.match(source, /observedPairingSession\.current = nextPairing\.pairingSessionId/u);
});

test("Tailscale and folder controls explain their bounded ownership", () => {
  assert.match(source, /never enables Funnel, and never resets unrelated routes/u);
  assert.match(source, /Paired devices can explore only these roots/u);
  assert.match(source, /Existing Aiden workspaces are unchanged/u);
});

test("Tailscale takeover is disclosed only for a stale Aiden route with bounded safe copy", () => {
  assert.match(source, /status\.tailscaleRouteState === "other_aiden_stale"/u);
  assert.match(source, /aidenRemoteApi\.reviewTailscaleTakeover/u);
  assert.match(source, /aidenRemoteApi\.takeOverTailscale\(takeoverReview\.token\)/u);
  assert.match(source, /replace only \/api\/aiden\/v1/u);
  assert.match(source, /preserve every other Serve handler/u);
  assert.match(source, /Another running Aiden profile owns this desktop’s mobile route/u);
  assert.doesNotMatch(source, /tailscale_route_conflict.*toast\.error/u);
});

test("Tailscale setup failures retain typed actionable remediation", () => {
  assert.match(source, /status\.tailscaleErrorCode === "not_installed"/u);
  assert.match(source, /status\.tailscaleErrorCode === "not_connected"/u);
  assert.match(source, /status\.tailscaleErrorCode === "https_unavailable"/u);
  assert.match(source, /Open Tailscale and sign in/u);
  assert.match(source, /Enable HTTPS for this Tailscale device name/u);
  assert.match(source, /tailscale_permission_denied[\s\S]*?sudo tailscale set --operator=\$USER/u);
  assert.match(source, /<Badge color=\{status\.tailscaleConnected \? "green"/u);
});

test("uncertain Tailscale mutations require an explicit verification action", () => {
  assert.match(source, /case "reconciliation_required"/u);
  assert.match(source, /Verification needed/u);
  assert.match(source, /aidenRemoteApi\.reconcileTailscale/u);
  assert.match(source, /Verify update/u);
});

test("primary connection tasks stay visible while advanced details use progressive disclosure", () => {
  assert.match(source, /title="Mobile devices"/u);
  assert.match(source, /Add device/u);
  assert.match(source, /<Disclosure[\s\S]*title="Connection"/u);
  assert.match(source, /<Disclosure[\s\S]*title="Workspace access"/u);
  assert.match(source, /<RemoteAccessInfo/u);
  assert.match(source, /Previous connections/u);
  assert.match(source, /groupRemoteDevices/u);
});

test("the persisted desktop label is editable without presenting it as identity", () => {
  assert.match(source, /label="Desktop name"/u);
  assert.match(source, /aidenRemoteApi\.setDisplayName/u);
  assert.match(source, /Identity remains/u);
  assert.match(source, /maxLength=\{80\}/u);
});

test("paired endpoint collisions use typed remediation without exposing socket errors", () => {
  assert.match(source, /status\.errorCode === "remote_port_in_use"/u);
  assert.match(source, /Another local Aiden profile is using this saved endpoint/u);
  assert.match(source, /Aiden will not silently move a saved mobile connection to a new port/u);
  assert.doesNotMatch(source, /EADDRINUSE/u);
});
