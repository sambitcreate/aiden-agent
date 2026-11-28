// The run-app card (design mode v2, Phase 2b). Before Aiden runs a workspace
// app's dev server, or installs its dependencies, main sends the exact
// commands and script text to the window that asked or owns the turn. This
// card shows them above the composer with Allow and Not now; nothing runs
// until the person answers Allow. Every waiting card shows, oldest first, so
// none times out unseen behind another. Its details scroll inside it, with a
// cue while their end is out of view, and Allow and Not now stay on screen.
// It also raises one toast when an app the person started fails or stops on
// its own. 2c adds the attach card: before design mode connects to a server
// the person runs that `.aiden/canvas.json` names, it shows the address, the
// process and its folder. 3d (S102) adds the scaffold card: before Aiden adds
// a design app, it asks the question and shows the folder, the files, what
// `npm ci` downloads and what `npm run dev` runs; its Allow is the launch
// consent too.

import { AppWindow } from "lucide-react";
import * as React from "react";
import { Button, Callout, toast } from "../components/ui";
import { isDismissKey } from "../lib/dismiss-key";
import { designAppApi } from "../lib/ipc";
import {
  DESIGN_APP_ATTACH_SCOPE,
  DESIGN_APP_CONSENT_SCOPE,
  designAppRootClass,
  designAppRootText,
  DESIGN_APP_INSTALL_NOTE,
  DESIGN_APP_SAVES_CHOICE,
  DESIGN_APP_SCAFFOLD_NETWORK,
  DESIGN_APP_SCAFFOLD_NO_SCRIPTS,
  consentDisplayText,
  consentScriptParts,
  designAppProblemMessage,
  type DesignAppConsentAnswer,
  type DesignAppConsentRequest,
  type DesignAppProblem,
  type DesignAppsSnapshot,
} from "../shared/design-app";

export type DesignAppLaunchRequest = Extract<DesignAppConsentRequest, { kind: "launch" }>;
export type DesignAppAttachRequest = Extract<DesignAppConsentRequest, { kind: "attach" }>;
export type DesignAppScaffoldRequest = Extract<DesignAppConsentRequest, { kind: "scaffold" }>;

/** The scaffold card shows this many files, then "and N more". */
const SCAFFOLD_FILES_SHOWN = 40;

const ANSWER_FAILED = "Aiden couldn't send your answer.";
const CRASHED = "The app's dev server stopped.";

/** Problems the person caused or saw in place: their own Not now, or a card that never had a window. */
const QUIET_PROBLEMS: ReadonlySet<DesignAppProblem["problem"]> = new Set([
  "consent-declined",
  "consent-unanswered",
  "consent-unavailable",
  "desktop-only",
  // 2c (D3): attach outcomes show in place, in the Connect sheet and the chip's menu.
  "attach-not-loopback",
  "attach-unreachable",
  "attach-not-in-app",
  "attach-url-invalid",
  "already-running",
]);

/**
 * Cards waiting in this window, by request id in arrival order, kept for the
 * whole app so switching chats and back still shows them. Main closes each
 * when it stops waiting.
 */
const waiting = new Map<string, DesignAppConsentRequest>();
const listeners = new Set<() => void>();
let installed = false;
let version = 0;
/** Each chat's list at the last version it was read, so React sees a stable snapshot. */
const lists = new Map<string, { version: number; requests: readonly DesignAppConsentRequest[] }>();
const NONE: readonly DesignAppConsentRequest[] = [];

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function waitingFor(chatId: string | undefined): readonly DesignAppConsentRequest[] {
  if (!chatId) return NONE;
  const kept = lists.get(chatId);
  if (kept?.version === version) return kept.requests;
  const requests = [...waiting.values()].filter((request) => request.chatId === chatId);
  const next = requests.length > 0 ? requests : NONE;
  lists.set(chatId, { version, requests: next });
  return next;
}

function drop(requestId: string) {
  if (waiting.delete(requestId)) changed();
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

function isAttachRequest(request: unknown): request is DesignAppAttachRequest {
  if (!request || typeof request !== "object") return false;
  const candidate = request as Partial<DesignAppAttachRequest>;
  return (
    candidate.kind === "attach" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.chatId === "string" &&
    typeof candidate.appRoot === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.configUrl === "string" &&
    typeof candidate.processName === "string" &&
    typeof candidate.folder === "string"
  );
}

function isScaffoldRequest(request: unknown): request is DesignAppScaffoldRequest {
  if (!request || typeof request !== "object") return false;
  const candidate = request as Partial<DesignAppScaffoldRequest>;
  return (
    candidate.kind === "scaffold" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.chatId === "string" &&
    typeof candidate.folder === "string" &&
    (candidate.mockKind === "react-nonweb" || candidate.mockKind === "starter") &&
    (candidate.shellLabel === undefined || typeof candidate.shellLabel === "string") &&
    typeof candidate.installCommand === "string" &&
    typeof candidate.runCommand === "string" &&
    Array.isArray(candidate.scripts) &&
    candidate.scripts.every((script) => typeof script?.name === "string" && typeof script.text === "string") &&
    Array.isArray(candidate.packages) &&
    candidate.packages.every((entry) => typeof entry?.name === "string" && typeof entry.version === "string") &&
    Array.isArray(candidate.files) &&
    candidate.files.every((file) => typeof file === "string")
  );
}

/** The scaffold card's question (S102): React mocks of a desktop or native app's screens, or a starter app. */
export function scaffoldQuestion(request: Pick<DesignAppScaffoldRequest, "mockKind" | "shellLabel" | "folder">): string {
  const folder = `${consentDisplayText(request.folder)}/`;
  if (request.mockKind === "starter") return `This folder has no web app. Add a small React app in ${folder} to design in?`;
  const what = request.shellLabel ? `an ${request.shellLabel} app`.replace(/^an (?=[^AEIOU])/u, "a ") : "a React app that isn't a web app";
  return `This is ${what}, so it can't run on the canvas. Make React mocks of its screens in ${folder} to iterate on?`;
}

function install() {
  if (installed) return;
  installed = true;
  designAppApi.onConsent((request) => {
    // A malformed card is never shown half-filled.
    if (!isLaunchRequest(request) && !isAttachRequest(request) && !isScaffoldRequest(request)) return;
    waiting.set(request.requestId, request);
    changed();
  });
  designAppApi.onConsentClosed((closed) => {
    if (typeof closed?.requestId === "string") drop(closed.requestId);
  });
}

/** For tests: forget cards, toasts and listeners between cases. */
export function resetDesignAppConsentForTests(): void {
  waiting.clear();
  lists.clear();
  listeners.clear();
  installed = false;
  toasted.clear();
}

/** The run-app and attach cards waiting for this chat, oldest first. */
export function useDesignAppConsents(chatId: string | undefined): readonly DesignAppConsentRequest[] {
  React.useEffect(() => install(), []);
  return React.useSyncExternalStore(
    React.useCallback((listener: () => void) => {
      install();
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, []),
    () => waitingFor(chatId),
  );
}

/**
 * Script text in full: no well scrolls on its own, every line break is marked,
 * and long blank or space runs show as their count (A-M2).
 */
function ScriptWell({ label, text, countLines = false }: { label: string; text: string; countLines?: boolean }) {
  const id = React.useId();
  const lines = text.split("\n").length;
  return (
    <div className="mt-2 min-w-0">
      <p id={id} className="text-small text-secondary">
        {countLines && lines > 1 ? `${label} · ${lines} lines` : label}
      </p>
      <pre
        aria-labelledby={id}
        className="approval-well mt-1 select-text bg-control px-3 py-2 font-mono text-small whitespace-pre-wrap break-words text-primary"
      >
        {consentScriptParts(text).map((part, index) =>
          part.kind === "break" ? (
            <React.Fragment key={index}>
              <span className="text-tertiary" aria-hidden="true">
                ↵
              </span>
              {"\n"}
            </React.Fragment>
          ) : part.kind === "gap" ? (
            <span key={index} className="text-tertiary">
              {part.text}
            </span>
          ) : (
            <React.Fragment key={index}>{part.text}</React.Fragment>
          ),
        )}
      </pre>
    </div>
  );
}

/** Whether a scroll box's end is out of view, measured on scroll and resize. */
function useMoreBelow(box: React.RefObject<HTMLElement | null>): [boolean, () => void] {
  const [more, setMore] = React.useState(false);
  const measure = React.useCallback(() => {
    const element = box.current;
    setMore(!!element && element.scrollTop + element.clientHeight < element.scrollHeight - 1);
  }, [box]);
  React.useLayoutEffect(() => {
    measure();
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, measure]);
  return [more, measure];
}

/** A card's answer, once, and its first focus on Not now. */
function useCardAnswer(requestId: string) {
  const [answering, setAnswering] = React.useState<DesignAppConsentAnswer | null>(null);
  const notNowRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    // A card that arrives while the person is in another run-app card leaves their focus there.
    if (document.activeElement?.closest("[data-design-app-card]")) return;
    notNowRef.current?.focus();
  }, []);

  const answer = async (choice: DesignAppConsentAnswer) => {
    if (answering) return;
    setAnswering(choice);
    try {
      const accepted = await designAppApi.answerConsent(requestId, choice);
      if (!accepted) toast.info("Aiden is no longer waiting for this answer.");
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : ANSWER_FAILED);
    } finally {
      // Main closes the card either way; drop it here too in case the window missed that.
      drop(requestId);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!isDismissKey(event)) return;
    event.preventDefault();
    void answer("decline");
  };
  return { answering, notNowRef, answer, onKeyDown };
}

export function DesignAppConsentCard({ request, stacked = false }: { request: DesignAppConsentRequest; stacked?: boolean }) {
  if (request.kind === "scaffold") return <DesignAppScaffoldCard request={request} stacked={stacked} />;
  return request.kind === "attach" ? <DesignAppAttachCard request={request} /> : <DesignAppLaunchCard request={request} stacked={stacked} />;
}

/**
 * 2c (D10): before design mode connects to a server `.aiden/canvas.json`
 * names. It shows the address main found, the url the file asks for, and the
 * process and folder that hold it; Allow binds to exactly those.
 */
function DesignAppAttachCard({ request }: { request: DesignAppAttachRequest }) {
  const { answering, notNowRef, answer, onKeyDown } = useCardAnswer(request.requestId);
  const address = request.url.replace(/^http:\/\//u, "");
  const title = `Connect to ${consentDisplayText(request.processName)} at ${address}?`;
  return (
    <Callout role="group" aria-label={title} data-design-app-card="" onKeyDown={onKeyDown}>
      <div className="flex items-start gap-2">
        <AppWindow className="mt-0.5 size-3.5 shrink-0 text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium break-words text-primary">{title}</p>
          <p className="mt-0.5 text-small break-words text-secondary">
            .aiden/canvas.json asks for <span className="font-mono">{consentDisplayText(request.configUrl)}</span>
          </p>
          <p className="mt-0.5 text-small break-words text-secondary">
            Folder: <span className={designAppRootClass(request.folder)}>{designAppRootText(request.folder)}</span>
          </p>
          <p className="mt-0.5 text-small break-words text-secondary">
            App <span className={designAppRootClass(request.appRoot)}>{designAppRootText(request.appRoot)}</span>
          </p>
          <p className="mt-2 text-small text-tertiary">{DESIGN_APP_ATTACH_SCOPE}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <Button ref={notNowRef} variant="transparent" size="small" disabled={answering !== null} onClick={() => void answer("decline")}>
          Not now
        </Button>
        <Button variant="accent" size="small" disabled={answering !== null} onClick={() => void answer("allow")}>
          {answering === "allow" ? "Connecting…" : "Allow"}
        </Button>
      </div>
    </Callout>
  );
}

function DesignAppLaunchCard({ request, stacked = false }: { request: DesignAppLaunchRequest; stacked?: boolean }) {
  const { answering, notNowRef, answer, onKeyDown } = useCardAnswer(request.requestId);
  const detailsRef = React.useRef<HTMLDivElement>(null);
  const [more, measure] = useMoreBelow(detailsRef);
  const again = request.reason === "changed" || request.reason === "install";
  const title = `Run ${request.frameworkLabel} app${again ? " again" : ""}?`;

  return (
    <Callout
      role="group"
      aria-label={title}
      data-design-app-card=""
      onKeyDown={onKeyDown}
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
        </div>
      </div>
      {/* The details scroll here, so the question and the buttons stay on screen however long the scripts are. */}
      <div
        ref={detailsRef}
        role="region"
        aria-label="What Allow runs"
        tabIndex={0}
        onScroll={measure}
        className={`${stacked ? "max-h-[25vh]" : "max-h-[50vh]"} min-w-0 overflow-y-auto rounded-control pl-5.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring`}
      >
        <ScriptWell label="Runs" text={request.runCommand} />
        {request.installCommand ? (
          <>
            <ScriptWell label="Installs first" text={request.installCommand} />
            <p className="mt-1 text-small text-tertiary">{DESIGN_APP_INSTALL_NOTE}</p>
          </>
        ) : null}
        {request.scripts.map((script) => (
          <ScriptWell key={script.name} label={`Script ${consentDisplayText(script.name)}`} text={script.text} countLines />
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
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {more ? <p className="mr-auto pl-5.5 text-small text-tertiary">Scroll for more</p> : null}
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
  );
}

/**
 * 3d (S102): before Aiden adds a design app. Nothing is written, installed or
 * started until Add design app; its Allow also approves the launch, so no
 * run-app card follows.
 */
function DesignAppScaffoldCard({ request, stacked = false }: { request: DesignAppScaffoldRequest; stacked?: boolean }) {
  const { answering, notNowRef, answer, onKeyDown } = useCardAnswer(request.requestId);
  const detailsRef = React.useRef<HTMLDivElement>(null);
  const [more, measure] = useMoreBelow(detailsRef);
  const title = scaffoldQuestion(request);
  const shown = request.files.slice(0, SCAFFOLD_FILES_SHOWN);
  const hidden = request.files.length - shown.length;
  return (
    <Callout role="group" aria-label={title} data-design-app-card="" onKeyDown={onKeyDown}>
      <div className="flex items-start gap-2">
        <AppWindow className="mt-0.5 size-3.5 shrink-0 text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-small font-medium break-words text-primary">{title}</p>
          <p className="mt-0.5 text-small break-words text-secondary">
            Adds <span className="font-mono">{consentDisplayText(request.folder)}/</span> and an entry in{" "}
            <span className="font-mono">.aiden/canvas.json</span>
          </p>
        </div>
      </div>
      <div
        ref={detailsRef}
        role="region"
        aria-label="What Add design app does"
        tabIndex={0}
        onScroll={measure}
        className={`${stacked ? "max-h-[25vh]" : "max-h-[50vh]"} min-w-0 overflow-y-auto rounded-control pl-5.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring`}
      >
        <ScriptWell label="Installs" text={request.installCommand} />
        <p className="mt-1 text-small break-words text-secondary">
          {request.packages.map((entry, index) => (
            <React.Fragment key={entry.name}>
              {index > 0 ? ", " : null}
              <span className="font-mono">
                {consentDisplayText(entry.name)} {consentDisplayText(entry.version)}
              </span>
            </React.Fragment>
          ))}
        </p>
        <p className="mt-1 text-small text-tertiary">
          {DESIGN_APP_SCAFFOLD_NETWORK} {DESIGN_APP_SCAFFOLD_NO_SCRIPTS}
        </p>
        <ScriptWell label="Runs" text={request.runCommand} />
        {request.scripts.map((script) => (
          <ScriptWell key={script.name} label={`Script ${consentDisplayText(script.name)}`} text={script.text} countLines />
        ))}
        <p className="mt-2 text-small text-secondary">Writes</p>
        <ul aria-label="Files it writes" className="mt-0.5 text-small break-words text-secondary">
          {shown.map((file) => (
            <li key={file} className="font-mono">
              {consentDisplayText(file)}
            </li>
          ))}
          {hidden > 0 ? <li>and {hidden} more</li> : null}
        </ul>
        <p className="mt-2 text-small text-tertiary">{DESIGN_APP_CONSENT_SCOPE}</p>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {more ? <p className="mr-auto pl-5.5 text-small text-tertiary">Scroll for more</p> : null}
        <Button ref={notNowRef} variant="transparent" size="small" disabled={answering !== null} onClick={() => void answer("decline")}>
          Not now
        </Button>
        <Button variant="accent" size="small" disabled={answering !== null} onClick={() => void answer("allow")}>
          {answering === "allow" ? "Adding…" : "Add design app"}
        </Button>
      </div>
    </Callout>
  );
}

/** Every run-app and attach card waiting for the chat, stacked oldest first above the composer. */
export function DesignAppConsentCards({ requests }: { requests: readonly DesignAppConsentRequest[] }) {
  return (
    <div className="aiden-dock-inset chat-content-column flex flex-col gap-2 pb-2">
      {requests.map((request) => (
        <DesignAppConsentCard key={request.requestId} request={request} stacked={requests.length > 1} />
      ))}
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
        ? designAppProblemMessage(app.problem, { mock: app.mock === true })
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
