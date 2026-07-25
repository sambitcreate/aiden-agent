import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LoaderCircle, LogIn, MessageSquareCode, RefreshCw } from "lucide-react";

import { AlertDialog, Badge, Button, Input, Separator, Text, toast } from "../ui";
import { CopyButton } from "../copy-button";
import { providersApi } from "../../lib/ipc";
import {
  createCodexAuthSession,
  handleCodexAuthTerminal,
  releaseCodexAuthSession,
  type CodexAuthSession,
} from "../../lib/codex-auth-session";
import { initialCodexAuthViewState, reduceCodexAuthView } from "../../lib/codex-auth-view-state";
import {
  logoutCodexProvider,
  refreshCodexProviderState,
  useCodexProviderStatus,
} from "../../lib/queries";
import type { ProviderAuthPrompt } from "../../lib/types";

function formatExpiry(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `Expires in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function statusBadge(
  signingOut: boolean,
  checking: boolean,
  error: boolean,
  configured: boolean,
): React.ReactNode {
  if (signingOut) return <Badge color="secondary">Signing out</Badge>;
  if (checking) return <Badge color="secondary">Checking</Badge>;
  if (error) return <Badge color="red">Needs attention</Badge>;
  if (configured) return <Badge color="green">Configured</Badge>;
  return <Badge color="secondary">Sign in needed</Badge>;
}

export function CodexProviderSettings() {
  const queryClient = useQueryClient();
  const status = useCodexProviderStatus();
  const sessionRef = React.useRef<CodexAuthSession | null>(null);
  const mountedRef = React.useRef(true);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const actionControlRef = React.useRef<HTMLAnchorElement>(null);
  const deviceCodeRegionRef = React.useRef<HTMLDivElement>(null);
  const firstOptionRef = React.useRef<HTMLButtonElement>(null);
  const promptInputRef = React.useRef<HTMLInputElement>(null);
  const cancelControlRef = React.useRef<HTMLButtonElement>(null);
  const promptOperationRef = React.useRef<{
    session: CodexAuthSession;
    promptId: string;
    token: symbol;
  } | null>(null);
  const cancelOperationRef = React.useRef<CodexAuthSession | null>(null);
  const [authState, dispatchAuth] = React.useReducer(
    reduceCodexAuthView,
    initialCodexAuthViewState,
  );
  const { view: authView, authFailure, promptFailure, promptValue, promptGeneration } = authState;
  const [signingOut, setSigningOut] = React.useState(false);
  const [confirmSignOut, setConfirmSignOut] = React.useState(false);
  const [statusRetryNotice, setStatusRetryNotice] = React.useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const promptFailureId = React.useId();
  const authFailureId = React.useId();
  const cardTitleId = React.useId();
  const authStepMessageId = React.useId();
  const deviceCodeHeadingId = React.useId();
  const deviceCodeValueId = React.useId();

  const refreshProviderState = React.useCallback(() => {
    void refreshCodexProviderState(queryClient);
  }, [queryClient]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      promptOperationRef.current = null;
      cancelOperationRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      void releaseCodexAuthSession(session);
    };
  }, []);

  React.useEffect(() => {
    if (!authView) return;
    const frame = requestAnimationFrame(() => {
      if (authView.phase === "responding" || authView.phase === "cancel_failed") {
        cancelControlRef.current?.focus();
      } else if (authView.prompt?.type === "select") {
        firstOptionRef.current?.focus();
      } else if (authView.prompt) {
        promptInputRef.current?.focus();
      } else if (authView.action?.type === "device_code") {
        deviceCodeRegionRef.current?.focus();
      } else if (authView.action) {
        actionControlRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    authView?.action?.type,
    authView?.action?.type === "auth_url" ? authView.action.url : undefined,
    authView?.action?.type === "device_code" ? authView.action.userCode : undefined,
    authView?.phase,
    authView?.prompt?.promptId,
  ]);

  const restoreCardFocus = React.useCallback(() => {
    requestAnimationFrame(() => cardRef.current?.focus());
  }, []);

  const beginSignIn = React.useCallback(async () => {
    if (sessionRef.current) return;
    dispatchAuth({ type: "clear-auth-failure" });
    setStatusRetryNotice(null);

    let session: CodexAuthSession;
    try {
      session = createCodexAuthSession(providersApi, {
        onPrompt: (prompt) => {
          promptOperationRef.current = null;
          dispatchAuth({ type: "prompt", prompt });
        },
        onEvent: (event) => {
          dispatchAuth({ type: "event", event });
        },
        onDone: (event) => {
          if (sessionRef.current?.flowId === event.flowId) sessionRef.current = null;
          promptOperationRef.current = null;
          cancelOperationRef.current = null;
          handleCodexAuthTerminal({
            refreshProviderState,
            isMounted: () => mountedRef.current,
            updateMountedView: () => {
              dispatchAuth({ type: "done", flowId: event.flowId });
              if (event.cancelled) toast.info("ChatGPT sign-in cancelled.");
              else toast.success("ChatGPT sign-in is configured.");
              restoreCardFocus();
            },
          });
        },
        onError: (event) => {
          if (sessionRef.current?.flowId === event.flowId) sessionRef.current = null;
          promptOperationRef.current = null;
          cancelOperationRef.current = null;
          handleCodexAuthTerminal({
            refreshProviderState,
            isMounted: () => mountedRef.current,
            updateMountedView: () => {
              dispatchAuth({ type: "error", flowId: event.flowId, message: event.message });
              restoreCardFocus();
            },
          });
        },
      });
    } catch {
      dispatchAuth({
        type: "set-auth-failure",
        message: "ChatGPT sign-in is unavailable in this window. Reload Aiden and try again.",
      });
      restoreCardFocus();
      return;
    }

    sessionRef.current = session;
    dispatchAuth({ type: "start", flowId: session.flowId });

    try {
      await session.start();
      if (!mountedRef.current) return;
      dispatchAuth({ type: "started", flowId: session.flowId });
    } catch {
      if (!mountedRef.current || sessionRef.current !== session) return;
      sessionRef.current = null;
      dispatchAuth({
        type: "start-error",
        flowId: session.flowId,
        message:
          "ChatGPT sign-in could not start. Finish any other sign-in attempt, then try again.",
      });
      restoreCardFocus();
    }
  }, [refreshProviderState, restoreCardFocus]);

  const respond = React.useCallback(async (prompt: ProviderAuthPrompt, value: string) => {
    const session = sessionRef.current;
    if (
      !session ||
      session.flowId !== prompt.flowId ||
      session.isCancelling() ||
      !session.isCurrentPrompt(prompt.promptId) ||
      promptOperationRef.current
    ) {
      return;
    }
    const operation = { session, promptId: prompt.promptId, token: Symbol(prompt.promptId) };
    promptOperationRef.current = operation;
    dispatchAuth({ type: "responding", flowId: prompt.flowId, promptId: prompt.promptId });
    try {
      await session.respond(prompt.promptId, value);
      if (
        !mountedRef.current ||
        sessionRef.current !== session ||
        promptOperationRef.current !== operation ||
        !session.isCurrentPrompt(prompt.promptId)
      ) {
        return;
      }
      promptOperationRef.current = null;
      dispatchAuth({
        type: "response-accepted",
        flowId: prompt.flowId,
        promptId: prompt.promptId,
      });
    } catch {
      if (
        !mountedRef.current ||
        sessionRef.current !== session ||
        promptOperationRef.current !== operation ||
        !session.isCurrentPrompt(prompt.promptId)
      ) {
        return;
      }
      promptOperationRef.current = null;
      dispatchAuth({
        type: "response-rejected",
        flowId: prompt.flowId,
        promptId: prompt.promptId,
        message: "That sign-in response was not accepted. Check it and try again.",
      });
    }
  }, []);

  const cancelSignIn = React.useCallback(async () => {
    const session = sessionRef.current;
    if (!session || cancelOperationRef.current) return;
    const flowId = session.flowId;
    cancelOperationRef.current = session;
    promptOperationRef.current = null;
    dispatchAuth({ type: "cancelling", flowId });
    try {
      const result = await session.cancel();
      if (
        !mountedRef.current ||
        sessionRef.current !== session ||
        cancelOperationRef.current !== session
      ) {
        return;
      }
      cancelOperationRef.current = null;
      dispatchAuth({ type: "cancel-result", flowId, finishing: !result.cancelled });
    } catch {
      if (
        !mountedRef.current ||
        sessionRef.current !== session ||
        cancelOperationRef.current !== session
      ) {
        return;
      }
      cancelOperationRef.current = null;
      dispatchAuth({
        type: "cancel-rejected",
        flowId,
        message: "ChatGPT sign-in could not be cancelled. Try cancelling again.",
      });
    }
  }, []);

  const signOut = React.useCallback(async () => {
    setSigningOut(true);
    setConfirmSignOut(false);
    setStatusRetryNotice(null);
    restoreCardFocus();
    try {
      await logoutCodexProvider(queryClient);
      if (mountedRef.current) dispatchAuth({ type: "clear-auth-failure" });
      toast.success("Signed out of ChatGPT on this Mac.");
    } catch {
      toast.error("ChatGPT sign-out did not complete. Try again.");
    } finally {
      if (mountedRef.current) {
        setSigningOut(false);
        setConfirmSignOut(false);
        restoreCardFocus();
      }
    }
  }, [queryClient, restoreCardFocus]);

  const retryProviderStatus = React.useCallback(async () => {
    setStatusRetryNotice({ message: "Checking ChatGPT sign-in status…", error: false });
    try {
      const result = await status.refetch();
      if (!mountedRef.current) return;
      setStatusRetryNotice(
        result.isError
          ? {
              message: "ChatGPT sign-in status could not be refreshed. Try again.",
              error: true,
            }
          : { message: "ChatGPT sign-in status refreshed.", error: false },
      );
    } catch {
      if (!mountedRef.current) return;
      setStatusRetryNotice({
        message: "ChatGPT sign-in status could not be refreshed. Try again.",
        error: true,
      });
    }
  }, [status]);

  const configured = status.data?.configured === true;
  const needsAttention = status.data?.needsAttention === true;
  const busy = authView !== null || signingOut;
  const statusBusy = status.isLoading || status.isFetching;
  const prompt = authView?.phase === "waiting" ? authView.prompt : undefined;
  const responding = authView?.phase === "responding";
  const actionable = authView?.action;
  const waitingForUser =
    authView?.phase === "waiting" && (prompt !== undefined || actionable !== undefined);
  const passiveAuthStatus =
    authView !== null && !waitingForUser && authView.phase !== "cancel_failed";
  const cancelFailed = authView?.phase === "cancel_failed";

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={cardTitleId}
      className="rounded-card border border-separator outline-none focus-visible:bg-list-selection focus-visible:outline-none"
    >
      <div className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-subtle text-secondary">
            <MessageSquareCode className="size-4" aria-hidden />
          </div>
          <div
            className="min-w-0 flex-1"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Text id={cardTitleId} variant="strong">
                ChatGPT / Codex
              </Text>
              <Badge color="blue">Built in</Badge>
              <span>
                {statusBadge(signingOut, statusBusy, status.isError || needsAttention, configured)}
              </span>
            </div>
            <Text variant="small" color="secondary" className="mt-1 block">
              Use your ChatGPT account for Codex models. OAuth credentials stay encrypted on this
              Mac and are never shown to the renderer.
            </Text>
            <Text variant="small" color="tertiary" className="mt-1 block">
              {signingOut
                ? "Aiden is removing the encrypted ChatGPT credential from this Mac."
                : status.isFetching
                  ? "Aiden is checking the ChatGPT credential stored on this Mac."
                  : status.isError
                    ? "Aiden couldn't read the stored sign-in. Retry, sign in again, or clear it."
                    : needsAttention
                      ? "The stored ChatGPT sign-in was rejected or could not refresh. Sign in again to repair it."
                      : configured
                        ? "A ChatGPT credential is stored. Aiden verifies and refreshes it when a Codex request starts."
                        : "Sign in with ChatGPT to make Codex models available in the model picker."}
            </Text>
          </div>
        </div>
        <div className="flex w-full flex-wrap justify-start gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
          {status.isError ? (
            <Button
              variant="transparent"
              size="small"
              iconOnly
              aria-label="Retry ChatGPT status"
              disabled={busy || status.isFetching}
              onClick={() => void retryProviderStatus()}
            >
              <RefreshCw
                className={`size-4 ${status.isFetching ? "animate-spin" : ""}`}
                aria-hidden
              />
            </Button>
          ) : null}
          <Button
            variant={configured ? "filled" : "accent"}
            size="small"
            disabled={busy || statusBusy}
            onClick={() => void beginSignIn()}
          >
            <LogIn className="size-4" />
            {configured ? "Sign in again" : "Sign in"}
          </Button>
          {configured || status.isError ? (
            <Button
              variant="transparent"
              size="small"
              disabled={busy || statusBusy}
              onClick={() => setConfirmSignOut(true)}
            >
              {status.isError ? "Clear sign-in" : "Sign out"}
            </Button>
          ) : null}
        </div>
        {statusRetryNotice ? (
          <span
            className="sr-only"
            role={statusRetryNotice.error ? "alert" : "status"}
            aria-live={statusRetryNotice.error ? "assertive" : "polite"}
          >
            {statusRetryNotice.message}
          </span>
        ) : null}
        {signingOut ? (
          <span className="sr-only" role="status" aria-live="polite">
            Signing out of ChatGPT…
          </span>
        ) : null}
      </div>

      {authView || authFailure ? (
        <>
          <Separator />
          <div className="grid gap-3 bg-well/50 px-3.5 py-3">
            {authView ? (
              <div
                role={passiveAuthStatus ? "status" : undefined}
                aria-live={passiveAuthStatus ? "polite" : undefined}
                aria-atomic={passiveAuthStatus ? true : undefined}
                className="flex items-center gap-2 rounded-control text-small text-secondary"
              >
                {cancelFailed ? (
                  <RefreshCw className="size-4 shrink-0" aria-hidden />
                ) : waitingForUser ? (
                  <MessageSquareCode className="size-4 shrink-0" aria-hidden />
                ) : (
                  <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
                )}
                <span id={authStepMessageId}>{authView.message}</span>
              </div>
            ) : null}

            {actionable?.type === "auth_url" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild variant="filled" size="small">
                  <a
                    ref={actionControlRef}
                    href={actionable.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open sign-in page
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
                <Text variant="small" color="tertiary">
                  A browser window should already be open.
                </Text>
              </div>
            ) : null}

            {actionable?.type === "device_code" ? (
              <div
                ref={deviceCodeRegionRef}
                tabIndex={-1}
                role="group"
                aria-labelledby={deviceCodeHeadingId}
                aria-describedby={deviceCodeValueId}
                className="grid gap-2 rounded-control border border-separator bg-popover px-3 py-2.5 outline-none focus-visible:bg-list-selection focus-visible:outline-none"
              >
                <Text id={deviceCodeHeadingId} variant="small" color="tertiary">
                  Temporary OpenAI device code
                </Text>
                <div className="flex items-center gap-2">
                  <code
                    id={deviceCodeValueId}
                    className="min-w-0 flex-1 select-all break-all font-mono text-heading2 font-semibold tracking-wider text-primary"
                  >
                    {actionable.userCode}
                  </code>
                  <CopyButton text={actionable.userCode} label="Copy device code" />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild variant="filled" size="small">
                    <a
                      ref={actionControlRef}
                      href={actionable.verificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open verification page
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                  {formatExpiry(actionable.expiresInSeconds) ? (
                    <Text variant="small" color="tertiary">
                      {formatExpiry(actionable.expiresInSeconds)}
                    </Text>
                  ) : null}
                </div>
              </div>
            ) : null}

            {prompt?.type === "select" && prompt.options ? (
              <div
                role="group"
                aria-labelledby={authStepMessageId}
                aria-describedby={promptFailure ? promptFailureId : undefined}
                className="grid gap-2 sm:grid-cols-2"
              >
                {prompt.options.map((option, index) => (
                  <button
                    ref={index === 0 ? firstOptionRef : undefined}
                    key={option.id}
                    type="button"
                    disabled={responding}
                    onClick={() => void respond(prompt, option.id)}
                    className="rounded-control border border-field bg-popover px-3 py-2 text-left outline-none transition-[background-color,border-color,box-shadow,opacity] duration-150 ease-out hover:border-primary/30 hover:bg-control focus-visible:bg-list-selection focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
                  >
                    <Text variant="small-strong" as="span" className="block">
                      {option.label}
                    </Text>
                    {option.description ? (
                      <Text variant="small" color="tertiary" as="span" className="mt-0.5 block">
                        {option.description}
                      </Text>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}

            {prompt && prompt.type !== "select" ? (
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (promptValue.length > 0) void respond(prompt, promptValue);
                }}
              >
                <Input
                  ref={promptInputRef}
                  type={prompt.type === "secret" ? "password" : "text"}
                  autoComplete="off"
                  value={promptValue}
                  disabled={responding}
                  aria-invalid={promptFailure ? true : undefined}
                  aria-describedby={promptFailure ? promptFailureId : undefined}
                  aria-label={prompt.message}
                  placeholder={prompt.placeholder}
                  onChange={(event) =>
                    dispatchAuth({
                      type: "prompt-value",
                      flowId: prompt.flowId,
                      promptId: prompt.promptId,
                      generation: promptGeneration,
                      value: event.target.value,
                    })
                  }
                />
                <Button
                  type="submit"
                  variant="accent"
                  size="small"
                  disabled={responding || promptValue.length === 0}
                >
                  Continue
                </Button>
              </form>
            ) : null}

            {promptFailure ? (
              <Text id={promptFailureId} variant="small" color="red" as="p">
                {promptFailure}
              </Text>
            ) : null}

            {authFailure ? (
              <Text
                id={authFailureId}
                variant="small"
                color="red"
                as="p"
                role={cancelFailed ? undefined : "alert"}
              >
                {authFailure}
              </Text>
            ) : null}

            {authView ? (
              <div>
                <Button
                  ref={cancelControlRef}
                  variant="transparent"
                  size="small"
                  aria-describedby={cancelFailed && authFailure ? authFailureId : undefined}
                  disabled={
                    authView.phase === "starting" ||
                    authView.phase === "cancelling" ||
                    authView.phase === "finishing"
                  }
                  onClick={() => void cancelSignIn()}
                >
                  {cancelFailed ? "Retry cancel" : "Cancel sign-in"}
                </Button>
              </div>
            ) : authFailure ? (
              <div>
                <Button variant="filled" size="small" onClick={() => void beginSignIn()}>
                  Try again
                </Button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      <AlertDialog
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        title={status.isError ? "Clear ChatGPT sign-in?" : "Sign out of ChatGPT?"}
        description="Aiden will remove the encrypted ChatGPT credential stored on this Mac. You can sign in again at any time."
        confirmLabel={status.isError ? "Clear sign-in" : "Sign out"}
        confirmVariant="destructive"
        onConfirm={signOut}
      />
    </div>
  );
}
