// The run-app card (design mode v2, Phase 2b). Before Aiden runs a workspace
// app's dev server, or installs its dependencies, main sends the exact
// commands and script text to the window that asked or owns the turn. This
// card shows them above the composer with Allow and Not now; nothing runs
// until the person answers Allow. It also raises one toast when an app the
// person started fails or stops on its own.

import { AppWindow } from "lucide-react";
import * as React from "react";
import { Button, Callout, toast } from "../components/ui";
import { isDismissKey } from "../lib/dismiss-key";
import { designAppApi } from "../lib/ipc";
import {
  DESIGN_APP_CONSENT_SCOPE,
  DESIGN_APP_INSTALL_NOTE,
  DESIGN_APP_SAVES_CHOICE,
  consentDisplayText,
  designAppProblemMessage,
  type DesignAppConsentAnswer,
  type DesignAppConsentRequest,
  type DesignAppProblem,
  type DesignAppsSnapshot,
} from "../shared/design-app";

export type DesignAppLaunchRequest = Extract<DesignAppConsentRequest, { kind: "launch" }>;

const ANSWER_FAILED = "Aiden couldn't send your answer.";
const CRASHED = "The app's dev server stopped.";

/** Problems the person caused or saw in place: their own Not now, or a card that never had a window. */
const QUIET_PROBLEMS: ReadonlySet<DesignAppProblem["problem"]> = new Set([
  "consent-declined",
  "consent-unanswered",
  "consent-unavailable",
  "desktop-only",
]);

/**
 * Cards waiting in this window, by chat, kept for the whole app so switching
 * chats and back still shows the card. One per chat, the newest; main closes
 * the others when they stop waiting.
 */
const waiting = new Map<string, DesignAppLaunchRequest>();
const listeners = new Set<() => void>();
let installed = false;

function changed() {
  for (const listener of listeners) listener();
}

function isLaunchRequest(request: unknown): request is DesignAppLaunchRequest {
  if (!request || typeof request !== "object") return false;
  const candidate = request as Partial<DesignAppLaunchRequest>;
  return (
    candidate.kind === "launch" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.chatId === "string" &&
    typeof candidate.appRoot === "string" &&
    typeof candidate.frameworkLabel === "string" &&
    typeof candidate.runCommand === "string" &&
    Array.isArray(candidate.scripts) &&
    candidate.scripts.every((script) => typeof script?.name === "string" && typeof script.text === "string") &&
    Array.isArray(candidate.launchFiles) &&
    candidate.launchFiles.every((file) => typeof file === "string")
  );
}

function install() {
  if (installed) return;
  installed = true;
  designAppApi.onConsent((request) => {
    // 2c renders attach cards; a malformed launch card is never shown half-filled.
    if (!isLaunchRequest(request)) return;
    waiting.set(request.chatId, request);
    changed();
  });
  designAppApi.onConsentClosed((closed) => {
    for (const [chatId, request] of waiting) {
      if (request.requestId === closed?.requestId) waiting.delete(chatId);
    }
    changed();
  });
}

/** For tests: forget cards, toasts and listeners between cases. */
export function resetDesignAppConsentForTests(): void {
  waiting.clear();
  listeners.clear();
  installed = false;
  toasted.clear();
}

/** The run-app card waiting for this chat, if any. */
export function useDesignAppConsent(chatId: string | undefined): DesignAppLaunchRequest | null {
  React.useEffect(() => install(), []);
  return React.useSyncExternalStore(
    React.useCallback((listener: () => void) => {
      install();
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, []),
    () => (chatId ? (waiting.get(chatId) ?? null) : null),
  );
}

function ScriptWell({ label, text }: { label: string; text: string }) {
  const id = React.useId();
  return (
    <div className="mt-2 min-w-0">
      <p id={id} className="text-small text-secondary">
        {label}
      </p>
      <pre
        aria-labelledby={id}
        tabIndex={0}
        className="approval-well mt-1 max-h-32 select-text overflow-y-auto bg-control px-3 py-2 font-mono text-small whitespace-pre-wrap break-words text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        {consentDisplayText(text)}
      </pre>
    </div>
  );
}

export function DesignAppConsentCard({ request }: { request: DesignAppLaunchRequest }) {
  const [answering, setAnswering] = React.useState<DesignAppConsentAnswer | null>(null);
  const notNowRef = React.useRef<HTMLButtonElement>(null);
  const again = request.reason === "changed" || request.reason === "install";
  const title = `Run ${request.frameworkLabel} app${again ? " again" : ""}?`;

  React.useEffect(() => {
    notNowRef.current?.focus();
  }, []);

  const answer = async (choice: DesignAppConsentAnswer) => {
    if (answering) return;
    setAnswering(choice);
    try {
      const accepted = await designAppApi.answerConsent(request.requestId, choice);
      if (!accepted) toast.info("Aiden is no longer waiting for this answer.");
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : ANSWER_FAILED);
    } finally {
      // Main closes the card either way; drop it here too in case the window missed that.
      if (waiting.get(request.chatId)?.requestId === request.requestId) {
        waiting.delete(request.chatId);
        changed();
      }
    }
  };

  return (
    <div className="aiden-dock-inset chat-content-column pb-2">
      <Callout
        role="group"
        aria-label={title}
        onKeyDown={(event: React.KeyboardEvent) => {
          if (!isDismissKey(event)) return;
          event.preventDefault();
          void answer("decline");
        }}
      >
        <div className="flex items-start gap-2">
          <AppWindow className="mt-0.5 size-3.5 shrink-0 text-secondary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-small font-medium text-primary">{title}</p>
            <p className="mt-0.5 text-small break-words text-secondary">
              <span className="font-mono">{consentDisplayText(request.appRoot)}</span>
              {request.packageName ? (
                <>
                  {" · "}
                  <span className="font-mono">{consentDisplayText(request.packageName)}</span>
                </>
              ) : null}
            </p>
            <ScriptWell label="Runs" text={request.runCommand} />
            {request.installCommand ? (
              <>
                <ScriptWell label="Installs first" text={request.installCommand} />
                <p className="mt-1 text-small text-tertiary">{DESIGN_APP_INSTALL_NOTE}</p>
              </>
            ) : null}
            {request.scripts.map((script) => (
              <ScriptWell key={script.name} label={`Script ${consentDisplayText(script.name)}`} text={script.text} />
            ))}
            {request.launchFiles.length > 0 ? (
              <p className="mt-2 text-small break-words text-secondary">
                Also reads{" "}
                {request.launchFiles.map((file, index) => (
                  <React.Fragment key={file}>
                    {index > 0 ? ", " : null}
                    <span className="font-mono">{consentDisplayText(file)}</span>
                  </React.Fragment>
                ))}
              </p>
            ) : null}
            {request.savesChoice ? <p className="mt-2 text-small text-secondary">{DESIGN_APP_SAVES_CHOICE}</p> : null}
            <p className="mt-2 text-small text-tertiary">{DESIGN_APP_CONSENT_SCOPE}</p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-1.5">
          <Button
            ref={notNowRef}
            variant="transparent"
            size="small"
            disabled={answering !== null}
            onClick={() => void answer("decline")}
          >
            Not now
          </Button>
          <Button variant="accent" size="small" disabled={answering !== null} onClick={() => void answer("allow")}>
            {answering === "allow" ? "Starting…" : "Allow"}
          </Button>
        </div>
      </Callout>
    </div>
  );
}

/** The last revision each app raised a toast for, by workspace and app root. */
const toasted = new Map<string, number>();

function toastProblems(snapshot: DesignAppsSnapshot | undefined) {
  if (!snapshot || !Array.isArray(snapshot.apps)) return;
  for (const app of snapshot.apps) {
    if (app?.startedBy !== "person" || typeof app.revision !== "number") continue;
    const message =
      app.problem && !QUIET_PROBLEMS.has(app.problem.problem)
        ? designAppProblemMessage(app.problem)
        : app.phase === "crashed"
          ? CRASHED
          : null;
    if (!message) continue;
    const key = `${app.workspaceId}\u0000${app.appRoot}`;
    if (toasted.get(key) === app.revision) continue;
    toasted.set(key, app.revision);
    // A fixed sentence only: the server's own output stays in its log, never in a toast.
    toast.error(message);
  }
}

/** Mounted once per window: one toast when an app the person started fails or stops on its own. */
export function DesignAppProblemToasts() {
  React.useEffect(() => designAppApi.onStatus(toastProblems), []);
  return null;
}
