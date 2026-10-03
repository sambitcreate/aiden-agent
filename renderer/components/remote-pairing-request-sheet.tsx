import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { Dialog, Text, toast } from "./ui";
import { aidenRemoteApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import { useAppCapabilities } from "../lib/app-capabilities";
import type { AidenRemotePairingRequestPrompt } from "../shared/aiden-remote";

/** Six digits shown as two groups of three, which are easier to compare aloud. */
export function formatPairingMatchCode(code: string): string {
  return /^\d{6}$/u.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function pairingRequestSecondsLeft(expiresAt: string, now: number): number {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.ceil((expires - now) / 1_000));
}

/**
 * The request to show next: the oldest live one the person has not already
 * answered. Requests whose countdown has run out are never offered, even if the
 * host's refresh has not arrived yet.
 *
 * While the person's answer to a request is still being applied (`pending`),
 * that request stays on screen and is the only one shown as busy, so the sheet
 * neither closes early nor carries "Allowing…" over to the next request.
 */
export function nextPairingRequest(
  prompts: readonly AidenRemotePairingRequestPrompt[],
  answered: ReadonlySet<string>,
  now: number,
  pending: string | null = null,
): { current: AidenRemotePairingRequestPrompt | null; waiting: number; busy: boolean } {
  const inFlight = pending === null
    ? undefined
    : prompts.find((prompt) => prompt.requestId === pending);
  const live = prompts.filter((prompt) =>
    prompt !== inFlight
    && !answered.has(prompt.requestId)
    && pairingRequestSecondsLeft(prompt.expiresAt, now) > 0);
  if (inFlight) return { current: inFlight, waiting: live.length, busy: true };
  const current = live[0] ?? null;
  return {
    current,
    waiting: Math.max(0, live.length - 1),
    busy: current?.approving ?? false,
  };
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PairingRequestSheetBody({
  prompt,
  secondsLeft,
  waiting,
}: {
  prompt: AidenRemotePairingRequestPrompt;
  secondsLeft: number;
  waiting: number;
}) {
  const digits = prompt.matchCode.split("").join(" ");
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex flex-col items-center gap-1 rounded-control bg-well px-4 py-4 text-center"
        data-pairing-match-code={prompt.matchCode}
      >
        <Text variant="small" color="secondary" className="block">Match code</Text>
        <span
          role="img"
          aria-label={`Match code ${digits}`}
          className="select-none font-mono text-heading1 font-semibold tracking-[0.18em] tabular-nums text-primary"
        >
          {formatPairingMatchCode(prompt.matchCode)}
        </span>
      </div>
      <div className="flex items-center gap-2 text-small text-secondary">
        <Laptop className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">
          {prompt.deviceType === "linux" ? "Linux" : "Mac"} · {prompt.transport === "tailscale" ? "Tailscale" : "Same network"}
        </span>
        <span role="timer" aria-live="off" className="shrink-0 tabular-nums">
          Expires in {formatCountdown(secondsLeft)}
        </span>
      </div>
      {waiting > 0 ? (
        <Text variant="small" color="secondary" className="block">
          {waiting === 1 ? "1 more request is waiting." : `${waiting} more requests are waiting.`}
        </Text>
      ) : null}
    </div>
  );
}

/**
 * App-wide approval sheet for desktop connection requests. Deny is the safe
 * default: it takes initial focus, and dismissing the sheet denies the request.
 */
export function PairingRequestSheet() {
  const capabilities = useAppCapabilities();
  const hostLabel = capabilities.platform === "darwin" ? "Mac" : "computer";
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: queryKeys.aidenRemotePairingRequests,
    queryFn: aidenRemoteApi.listPairingRequests,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const [answered, setAnswered] = React.useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = React.useState(() => Date.now());
  const [pending, setPending] = React.useState<string | null>(null);

  React.useEffect(() => aidenRemoteApi.onPairingRequestsChanged(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemotePairingRequests });
    void queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemote });
  }), [queryClient]);

  const prompts = requests.data ?? [];
  const { current, waiting, busy } = nextPairingRequest(prompts, answered, now, pending);

  React.useEffect(() => {
    if (!current) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [current]);

  // Forget answers for requests the host no longer lists.
  React.useEffect(() => {
    setAnswered((previous) => {
      const live = new Set(prompts.map((prompt) => prompt.requestId));
      const next = new Set([...previous].filter((id) => live.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [prompts]);

  const respond = async (decision: "allow" | "deny") => {
    if (!current || pending !== null) return;
    const request = current;
    setPending(request.requestId);
    try {
      const result = await aidenRemoteApi.respondPairingRequest(request.requestId, decision);
      if (decision === "allow") {
        if (result.failed) {
          toast.error(`Aiden couldn't connect ${request.deviceName}. Ask it to try again.`);
        } else if (result.state === "approved") {
          toast.success(`${request.deviceName} can now control this ${hostLabel}.`);
        } else {
          toast.info(`The request from ${request.deviceName} is no longer waiting.`);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Aiden couldn't answer this connection request.");
    } finally {
      // Only now move on, so the sheet stays on this request until it settles.
      setAnswered((previous) => new Set(previous).add(request.requestId));
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.aidenRemotePairingRequests });
    }
  };

  // Keep the last request on screen while the sheet animates closed.
  const lastShown = React.useRef<AidenRemotePairingRequestPrompt | null>(null);
  if (current) lastShown.current = current;
  const shown = current ?? lastShown.current;
  if (!shown) return null;
  const busyAllowing = current !== null && busy;
  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open) void respond("deny");
      }}
      title={(
        <span className="break-words">
          {shown.deviceName} wants to control this {hostLabel}
        </span>
      )}
      description={`Allow only if ${shown.deviceName} shows the same code. It will be able to use Aiden on this ${hostLabel} until you remove it in Remote Access settings.`}
      cancelLabel="Deny"
      confirmLabel={busyAllowing ? "Allowing…" : "Allow"}
      busy={busyAllowing}
      onConfirm={() => respond("allow")}
    >
      <PairingRequestSheetBody
        prompt={shown}
        secondsLeft={pairingRequestSecondsLeft(shown.expiresAt, now)}
        waiting={waiting}
      />
    </Dialog>
  );
}
