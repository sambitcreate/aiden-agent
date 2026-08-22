import * as React from "react";

import { ExternalLink } from "lucide-react";

import { Button, Dialog, Field, Input, Text, toast, type DialogLayer } from "../ui";
import { providersApi } from "../../lib/ipc";
import {
  createProviderAuthSession,
  type PiAuthMethod,
  type ProviderAuthSession,
} from "../../lib/provider-auth-session";
import type { Provider, ProviderAuthEvent, ProviderAuthPrompt } from "../../lib/types";
import { ProviderModelVisibility } from "./provider-model-visibility";

interface BuiltinProviderEditorProps {
  provider: Provider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  layer?: DialogLayer;
}

function eventCopy(event: ProviderAuthEvent): string {
  if (event.type === "device_code")
    return `Use code ${event.userCode} in the browser that just opened.`;
  if (event.type === "auth_url") return event.instructions ?? "Continue setup in your browser.";
  if (event.type === "browser_open_failed") return event.message;
  return event.message;
}

/**
 * Setup UI for every interactive Pi auth method. Pi prompts for the complete
 * credential shape, so providers such as Cloudflare can request account and
 * gateway IDs without Aiden inventing provider-specific config fields.
 */
export function BuiltinProviderEditor({
  provider,
  open,
  onOpenChange,
  onSaved,
  layer,
}: BuiltinProviderEditorProps) {
  const sessionRef = React.useRef<ProviderAuthSession | null>(null);
  const mountedRef = React.useRef(true);
  const openRef = React.useRef(open);
  const [prompt, setPrompt] = React.useState<ProviderAuthPrompt | null>(null);
  const [value, setValue] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [responding, setResponding] = React.useState(false);
  const [authLink, setAuthLink] = React.useState<string | null>(null);
  const interactiveMethods = (provider.authMethods ?? []).filter(
    (method): method is { type: PiAuthMethod; label: string; canLogin: true } => method.canLogin,
  );

  const releaseSession = React.useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session?.isActive()) return;
    void session
      .cancel()
      .then((result) => {
        if (result.cancelled) session.dispose();
      })
      .catch(() => session.dispose());
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      releaseSession();
      setPrompt(null);
      setValue("");
      setMessage(null);
      setStarting(false);
      setResponding(false);
      setAuthLink(null);
    }
  }, [open, provider.id, releaseSession]);

  React.useEffect(() => releaseSession, [releaseSession]);

  const close = (nextOpen: boolean) => {
    if (!nextOpen) releaseSession();
    onOpenChange(nextOpen);
  };

  const start = async (authType: PiAuthMethod) => {
    releaseSession();
    setPrompt(null);
    setValue("");
    setMessage("Starting native provider setup…");
    setStarting(true);
    try {
      const session = createProviderAuthSession(providersApi, provider.id, authType, {
        onPrompt: (nextPrompt) => {
          setAuthLink(null);
          setPrompt(nextPrompt);
          setValue("");
          setMessage(null);
          setStarting(false);
        },
        onEvent: (event) => {
          if (event.type === "auth_url" || event.type === "browser_open_failed") {
            setAuthLink(event.url);
          } else if (event.type === "device_code") {
            setAuthLink(event.verificationUri);
          }
          setMessage(eventCopy(event));
          setStarting(false);
        },
        onDone: async (event) => {
          sessionRef.current = null;
          if (event.cancelled) return;
          if (mountedRef.current && openRef.current) {
            setPrompt(null);
            setStarting(false);
          }
          try {
            const providers = await providersApi.list();
            const refreshed = providers.find((item) => item.id === provider.id);
            if (!refreshed?.hasKey || refreshed.models.length === 0) {
              if (mountedRef.current && openRef.current) {
                setMessage(
                  `${provider.label} is configured, but no usable chat model is available yet.`,
                );
              }
              return;
            }
            // A cancellation request can race the provider's irreversible
            // credential commit. Reconcile the parent/cache even if this
            // editor closed while the session reported `finishing`.
            onSaved();
            if (mountedRef.current && openRef.current) {
              if (event.warning) toast.warning(event.warning);
              else toast.success(`${provider.label} is configured.`);
              onOpenChange(false);
            }
          } catch (error) {
            if (mountedRef.current && openRef.current) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Setup completed, but provider readiness could not be checked.",
              );
            }
          }
        },
        onError: (error) => {
          sessionRef.current = null;
          if (!mountedRef.current || !openRef.current) return;
          setPrompt(null);
          setStarting(false);
          toast.error(error.message);
        },
      });
      sessionRef.current = session;
      await session.start();
    } catch (error) {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      setStarting(false);
      setMessage(
        error instanceof Error ? error.message : `Couldn't start ${provider.label} setup.`,
      );
    }
  };

  const respond = async (response: string) => {
    if (!prompt || !sessionRef.current?.isCurrentPrompt(prompt.promptId)) return;
    setResponding(true);
    try {
      await sessionRef.current.respond(prompt.promptId, response);
      setPrompt(null);
      setValue("");
      setMessage("Continuing native provider setup…");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't continue provider setup.");
    } finally {
      setResponding(false);
    }
  };

  const needsValue = prompt && prompt.type !== "select";
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      layer={layer}
      title={`Set up ${provider.label}`}
      description="Pi owns this provider's endpoint, models, credentials, and request transport."
      confirmLabel="Continue"
      confirmHidden={!needsValue}
      confirmDisabled={responding || !value.trim()}
      busy={responding}
      onConfirm={() => void respond(value)}
    >
      <div className="grid gap-4">
        {prompt?.type === "select" ? (
          <div className="grid gap-2" aria-label={prompt.message}>
            <Text variant="small" color="secondary">
              {prompt.message}
            </Text>
            {prompt.options?.map((option) => (
              <Button
                key={option.id}
                variant="muted"
                className="h-auto justify-start px-3 py-2 text-left"
                disabled={responding}
                onClick={() => void respond(option.id)}
              >
                <span className="flex flex-col items-start gap-0.5">
                  <span>{option.label}</span>
                  {option.description ? (
                    <span className="text-small font-normal text-tertiary">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
        ) : prompt ? (
          <Field label={prompt.message}>
            <Input
              autoFocus
              type={prompt.type === "secret" ? "password" : "text"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={prompt.placeholder}
              onKeyDown={(event) => {
                if (event.key === "Enter" && value.trim() && !responding) {
                  event.preventDefault();
                  void respond(value);
                }
              }}
            />
          </Field>
        ) : interactiveMethods.length > 0 ? (
          <div className="grid gap-2">
            <Text variant="small" color="secondary">
              Choose a setup method. Pi will ask only for the details this provider requires.
            </Text>
            {interactiveMethods.map((method) => (
              <Button
                key={method.type}
                variant="muted"
                disabled={starting}
                onClick={() => void start(method.type)}
              >
                {method.label}
              </Button>
            ))}
          </div>
        ) : (
          <Text variant="small" color="secondary">
            This provider uses credentials Pi discovers from your system or environment; there is no
            endpoint or manual credential configuration in Aiden.
          </Text>
        )}
        {message ? (
          <Text variant="small" color="tertiary" aria-live="polite">
            {message}
          </Text>
        ) : null}
        {authLink ? (
          <Button asChild variant="filled" size="small" className="justify-self-start">
            <a href={authLink} target="_blank" rel="noopener noreferrer">
              Open sign-in page <ExternalLink className="size-3.5" />
            </a>
          </Button>
        ) : null}
        <Text variant="small" color="tertiary">
          {provider.models.length} Pi model{provider.models.length === 1 ? "" : "s"} are currently
          available.
        </Text>
        <ProviderModelVisibility provider={provider} />
      </div>
    </Dialog>
  );
}
