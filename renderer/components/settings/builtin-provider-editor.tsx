import * as React from "react";

import { Button, Dialog, Field, Input, Text, toast } from "../ui";
import { providersApi } from "../../lib/ipc";
import {
  createProviderAuthSession,
  type PiAuthMethod,
  type ProviderAuthSession,
} from "../../lib/provider-auth-session";
import type { Provider, ProviderAuthEvent, ProviderAuthPrompt } from "../../lib/types";

interface BuiltinProviderEditorProps {
  provider: Provider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function eventCopy(event: ProviderAuthEvent): string {
  if (event.type === "device_code")
    return `Use code ${event.userCode} in the browser that just opened.`;
  if (event.type === "auth_url") return event.instructions ?? "Continue setup in your browser.";
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
}: BuiltinProviderEditorProps) {
  const sessionRef = React.useRef<ProviderAuthSession | null>(null);
  const [prompt, setPrompt] = React.useState<ProviderAuthPrompt | null>(null);
  const [value, setValue] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [responding, setResponding] = React.useState(false);
  const interactiveMethods = (provider.authMethods ?? []).filter(
    (method): method is { type: PiAuthMethod; label: string; canLogin: true } => method.canLogin,
  );

  const releaseSession = React.useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session?.isActive()) return;
    void session.cancel().catch(() => session.dispose());
  }, []);

  React.useEffect(() => {
    if (!open) {
      releaseSession();
      setPrompt(null);
      setValue("");
      setMessage(null);
      setStarting(false);
      setResponding(false);
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
          setPrompt(nextPrompt);
          setValue("");
          setMessage(null);
          setStarting(false);
        },
        onEvent: (event) => {
          setMessage(eventCopy(event));
          setStarting(false);
        },
        onDone: async (event) => {
          sessionRef.current = null;
          setPrompt(null);
          setStarting(false);
          if (event.cancelled) return;
          try {
            const providers = await providersApi.refresh();
            onSaved();
            const refreshed = providers.find((item) => item.id === provider.id);
            toast.success(
              refreshed?.hasKey
                ? `${provider.label} is ready.`
                : `${provider.label} setup completed.`,
            );
            onOpenChange(false);
          } catch (error) {
            setMessage(
              error instanceof Error
                ? error.message
                : "Setup completed, but the model catalog could not refresh.",
            );
          }
        },
        onError: (error) => {
          sessionRef.current = null;
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
        <Text variant="small" color="tertiary">
          {provider.models.length} Pi model{provider.models.length === 1 ? "" : "s"} are currently
          available.
        </Text>
      </div>
    </Dialog>
  );
}
