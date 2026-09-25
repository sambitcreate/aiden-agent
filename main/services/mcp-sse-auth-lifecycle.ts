/**
 * Compatibility seam for pinned MCP SDK 1.30 / EventSource 3.0.7. The SDK has
 * no public settled-reauthentication callback: its legacy SSE 401 branch can
 * reject authentication while leaving the mandatory receive stream CLOSED.
 * Keep installed-SDK tests for CLOSED, CONNECTING, and successful refresh when
 * upgrading either dependency. Unsupported shapes fail closed, not silently.
 */
export function observeSseReauthentication(
  transport: object,
  onTerminalFailure: () => void,
): void {
  const lifecycle = transport as {
    _authThenStart?: unknown;
    _eventSource?: { readyState?: unknown };
  };
  const reauthenticate = lifecycle._authThenStart;
  if (typeof reauthenticate !== "function") {
    throw new Error("Unsupported MCP SDK SSE authentication lifecycle.");
  }
  lifecycle._authThenStart = async () => {
    try {
      await reauthenticate.call(transport);
    } catch (error) {
      // Successful auth followed by a temporary fetch failure also rejects,
      // but EventSource remains CONNECTING (0) and owns its retry loop. OPEN
      // (1) likewise remains usable. CLOSED (2) or an unknown shape is unsafe.
      const state = lifecycle._eventSource?.readyState;
      if (state !== 0 && state !== 1) onTerminalFailure();
      throw error;
    }
  };
}
