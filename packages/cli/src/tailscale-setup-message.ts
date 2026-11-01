/**
 * Next steps for Tailscale setup failures. Kept apart from remote.ts so the
 * admin commands (`aiden remote check`, `aiden service install`) can name the
 * fix without loading the daemon and agent modules.
 */

const PAIR_TAILSCALE_AGAIN = "then run `aiden remote pair tailscale`.";

/** What to do next for each Tailscale setup failure, naming the exact commands. */
export function tailscaleSetupMessage(code: string): string | undefined {
  switch (code) {
    case "tailscale_not_installed": return `Tailscale is not installed on this server. Install it (https://tailscale.com/download), sign in with \`sudo tailscale up\`, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_not_connected":
    case "tailscale_status_unavailable": return `Tailscale is not signed in or not running on this server. Run \`sudo tailscale up\`, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_https_unavailable": return `HTTPS certificates are off for this tailnet. Turn on HTTPS in the Tailscale admin console (DNS, HTTPS Certificates), ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_permission_denied": return `Tailscale refused to change Serve settings for this user. Run \`sudo tailscale set --operator=$USER\` once, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_funnel_conflict": return `Tailscale Funnel is on for HTTPS port 443 on this machine, and Aiden will not put its private route behind a public Funnel. Turn that Funnel off, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_route_conflict": return "The Tailscale Serve path /api/aiden/v1 on this machine already points somewhere else, so Aiden left it unchanged. If it belongs to another Aiden install that is no longer running, run `aiden remote mode both`, then `aiden remote tailscale-review`, then `aiden remote tailscale-takeover <token>` with the token it prints; otherwise remove that route yourself (`tailscale serve status` shows it). Then run `aiden remote pair tailscale`.";
    case "tailscale_route_live": return "Another running Aiden install owns the Tailscale Serve path /api/aiden/v1 on this machine. Stop it (or pair through it) before pairing this server over Tailscale.";
    case "tailscale_reconciliation_required": return `A previous Tailscale route change did not report its outcome. Run \`aiden remote tailscale-reconcile\`, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_route_outcome_unknown":
    case "tailscale_route_verification_failed":
    case "tailscale_route_recovery_failed": return `Tailscale did not confirm Aiden's route change, so Aiden saved nothing. Run \`aiden remote tailscale-reconcile\` to check what Tailscale did, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_route_busy": return `Another Aiden install on this machine is changing the Tailscale route right now. Wait a moment, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_ownership_commit_failed": return `Aiden could not save its Tailscale route settings, so it put the route back as it was. Check that Aiden's data folder is writable, ${PAIR_TAILSCALE_AGAIN}`;
    case "tailscale_status_invalid":
    case "tailscale_status_invalid_response": return `Tailscale gave an answer Aiden could not read. Check that \`tailscale status\` works and Tailscale is up to date, ${PAIR_TAILSCALE_AGAIN}`;
    default: return undefined;
  }
}

export function withTailscaleSetupMessage(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  // A Tailscale code without its own fix still gets a next step rather than the bare code.
  const setup = tailscaleSetupMessage(message)
    ?? (/^tailscale_[a-z_]+$/u.test(message) ? `Tailscale setup did not finish (${message}). \`aiden remote check\` shows which step is missing; pairing over the local network (\`aiden remote pair lan\`) still works.` : undefined);
  return setup ? new Error(setup, { cause: error }) : error instanceof Error ? error : new Error(message);
}
