import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAidenRemoteDesktopFailure,
  isAidenRemoteTlsTimeoutError,
  isTailscalePermissionDeniedError,
  remoteDesktopResult,
} from "./aiden-remote-desktop-errors.js";
import { unwrapAidenRemoteDesktopResult } from "../../renderer/shared/aiden-remote.js";

test("TLS timeout errors map to a stable desktop pairing code", () => {
  const timeout = new Error("Aiden Remote TLS endpoint timed out.");
  timeout.name = "AidenRemoteTlsTimeoutError";
  assert.equal(isAidenRemoteTlsTimeoutError(timeout), true);
  const classified = classifyAidenRemoteDesktopFailure(timeout);
  assert.equal(classified.code, "tls_endpoint_timeout");
  assert.match(classified.message, /couldn't reach this Mac's Tailscale HTTPS endpoint in time/u);
});

test("Tailscale operator denials map to a stable permission code", () => {
  const denied = Object.assign(new Error("Command failed: tailscale serve"), {
    stderr: "Access denied: failed to connect to local tailscaled; try running `sudo tailscale set --operator=$USER`",
    code: 1,
  });
  assert.equal(isTailscalePermissionDeniedError(denied), true);
  const classified = classifyAidenRemoteDesktopFailure(denied);
  assert.equal(classified.code, "tailscale_permission_denied");
  assert.match(classified.message, /sudo tailscale set --operator=\$USER/u);
});

test("existing Tailscale route codes stay exact for renderer mapping", () => {
  const classified = classifyAidenRemoteDesktopFailure(new Error("tailscale_https_unavailable"));
  assert.equal(classified.code, "tailscale_https_unavailable");
  assert.notEqual(classified.message, "tailscale_https_unavailable");
  assert.match(classified.message, /couldn't safely update the Tailscale route/u);
});

test("remoteDesktopResult never rejects operational failures", async () => {
  const failure = await remoteDesktopResult(async () => {
    throw new Error("Aiden Remote TLS endpoint timed out.");
  });
  assert.equal(failure.ok, false);
  if (failure.ok) throw new Error("expected failure");
  assert.equal(failure.code, "tls_endpoint_timeout");
  assert.throws(
    () => unwrapAidenRemoteDesktopResult(failure),
    (error: unknown) => error instanceof Error && error.name === "AidenRemoteDesktopError",
  );

  const success = await remoteDesktopResult(async () => ({ connected: true }));
  assert.deepEqual(unwrapAidenRemoteDesktopResult(success), { connected: true });
});
