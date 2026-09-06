import type { AidenRemoteDesktopErrorCode, AidenRemoteDesktopResult } from "../../renderer/shared/aiden-remote.js";

const TLS_TIMEOUT_MESSAGE = "Aiden Remote TLS endpoint timed out.";

const USER_FACING_MESSAGES = {
  tls_endpoint_timeout:
    "Aiden couldn't reach this Mac's Tailscale HTTPS endpoint in time. Check the Serve route, then try again.",
  tls_endpoint_unreachable:
    "Aiden couldn't reach this Mac's Tailscale HTTPS endpoint. Check that Tailscale is running, then try again.",
  tls_invalid_certificate: "Aiden couldn't verify this Mac's Tailscale HTTPS certificate.",
  tailscale_permission_denied:
    "Aiden needs Tailscale operator permission. Run sudo tailscale set --operator=$USER, then try again.",
  tailscale_operation_failed: "Aiden couldn't safely update the Tailscale route.",
  pairing_failed: "Aiden couldn't open pairing.",
} as const;

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? "");
  const extra = error as Error & { stderr?: unknown; stdout?: unknown };
  return [error.message, extra.stderr, extra.stdout]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

export function isAidenRemoteTlsTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AidenRemoteTlsTimeoutError" || error.message === TLS_TIMEOUT_MESSAGE;
}

export function isTailscalePermissionDeniedError(error: unknown): boolean {
  const text = errorText(error);
  if (/tailscale_permission_denied/u.test(text)) return true;
  const extra = error !== null && typeof error === "object"
    ? error as { code?: unknown }
    : undefined;
  if (extra?.code === "EACCES") return true;
  if (/EACCES/u.test(text)) return true;
  if (/permission denied/iu.test(text)) return true;
  if (/access denied/iu.test(text)) return true;
  return false;
}

function isTlsUnreachableError(error: unknown): boolean {
  const extra = error !== null && typeof error === "object"
    ? error as { code?: unknown }
    : undefined;
  if (
    extra?.code === "ECONNREFUSED"
    || extra?.code === "ENOTFOUND"
    || extra?.code === "EHOSTUNREACH"
    || extra?.code === "ENETUNREACH"
    || extra?.code === "ECONNRESET"
    || extra?.code === "ETIMEDOUT"
  ) {
    return true;
  }
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ETIMEDOUT/u.test(errorText(error));
}

function isTlsCertificateError(error: unknown): boolean {
  const extra = error !== null && typeof error === "object"
    ? error as { code?: unknown }
    : undefined;
  if (
    extra?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || extra?.code === "CERT_HAS_EXPIRED"
    || extra?.code === "ERR_TLS_CERT_ALTNAME_INVALID"
    || extra?.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) {
    return true;
  }
  return /certificate|self[- ]signed|unable to verify/iu.test(errorText(error));
}

export function classifyAidenRemoteDesktopFailure(error: unknown): {
  code: AidenRemoteDesktopErrorCode | `tailscale_${string}`;
  message: string;
} {
  const thrown = error instanceof Error ? error.message.trim() : "";
  if (/^tailscale_[a-z0-9_]+$/u.test(thrown)) {
    if (thrown === "tailscale_permission_denied") {
      return {
        code: "tailscale_permission_denied",
        message: USER_FACING_MESSAGES.tailscale_permission_denied,
      };
    }
    return { code: thrown as `tailscale_${string}`, message: thrown };
  }
  if (isAidenRemoteTlsTimeoutError(error)) {
    return { code: "tls_endpoint_timeout", message: USER_FACING_MESSAGES.tls_endpoint_timeout };
  }
  if (isTlsUnreachableError(error)) {
    return { code: "tls_endpoint_unreachable", message: USER_FACING_MESSAGES.tls_endpoint_unreachable };
  }
  if (isTlsCertificateError(error)) {
    return { code: "tls_invalid_certificate", message: USER_FACING_MESSAGES.tls_invalid_certificate };
  }
  if (isTailscalePermissionDeniedError(error)) {
    return {
      code: "tailscale_permission_denied",
      message: USER_FACING_MESSAGES.tailscale_permission_denied,
    };
  }
  if (thrown.startsWith("Aiden Remote TLS") || thrown.includes("Tailscale")) {
    return { code: "pairing_failed", message: USER_FACING_MESSAGES.pairing_failed };
  }
  return { code: "tailscale_operation_failed", message: USER_FACING_MESSAGES.tailscale_operation_failed };
}

export async function remoteDesktopResult<T>(
  action: () => Promise<T>,
): Promise<AidenRemoteDesktopResult<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, ...classifyAidenRemoteDesktopFailure(error) };
  }
}
