import * as React from "react";
import { ChevronLeft, KeyRound, Laptop, UserRound } from "lucide-react";
import { Button, Text } from "./ui";
import { ProviderIcon } from "./provider-icon";
import type { Provider } from "../lib/types";
import { splitPiBuiltinProviders } from "../lib/pi-provider-display";
import { isAcpHarnessProvider } from "../shared/acp-harness";

type Method = "oauth" | "api_key" | "local" | "other";
export type ConnectionRoute =
  | { kind: "builtin"; provider: Provider; method?: "api_key" | "oauth" }
  | { kind: "local"; runtime: "lmstudio" | "ollama" }
  | { kind: "endpoint"; template: "custom" | "tailnet" }
  | { kind: "codex" };

const methods = [
  {
    id: "oauth",
    label: "I have an account",
    hint: "Sign in with ChatGPT or another service.",
    icon: UserRound,
  },
  { id: "api_key", label: "I have an API key", hint: "Use a key from your AI provider.", icon: KeyRound },
  { id: "local", label: "I run a local model", hint: "Connect LM Studio or Ollama.", icon: Laptop },
] as const;

export function GuidedProviderChooser({
  providers,
  onChoose,
  onBack,
  disabled,
  showEndpoints = true,
}: {
  providers: readonly Provider[];
  onChoose: (route: ConnectionRoute, trigger: HTMLButtonElement) => void;
  onBack?: () => void;
  disabled?: boolean;
  showEndpoints?: boolean;
}) {
  const [method, setMethod] = React.useState<Method | null>(null);
  const heading = React.useRef<HTMLHeadingElement>(null);
  const triggers = React.useRef<Partial<Record<Method, HTMLButtonElement | null>>>({});
  const previous = React.useRef(method);
  React.useLayoutEffect(() => {
    if (method) heading.current?.focus();
    else if (previous.current) triggers.current[previous.current]?.focus();
    previous.current = method;
  }, [method]);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const builtins = providers.filter((p) => p.isBuiltin && p.id !== "openai-codex");
  const { featured, more } = splitPiBuiltinProviders(builtins);
  const choices = [...featured, ...more].filter((provider) => {
    const available = provider.authMethods?.filter((item) => item.canLogin) ?? [];
    if (method === "other") return !available.length || isAcpHarnessProvider(provider.id);
    return available.some((item) => item.type === method);
  });
  const action = (label: string, route: ConnectionRoute, id: string) => (
    <Button
      key={id}
      variant="muted"
      disabled={disabled}
      className="justify-start"
      onClick={(event) => onChoose(route, event.currentTarget)}
    >
      <ProviderIcon providerId={id} providerLabel={label} className="size-4" />
      {label}
    </Button>
  );
  return (
    <div className="grid min-w-0 gap-3">
      {method ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="small"
              variant="transparent"
              disabled={disabled}
              onClick={() => {
                onBack?.();
                setMethod(null);
              }}
            >
              <ChevronLeft /> Connection methods
            </Button>
            <h3 ref={heading} tabIndex={-1} className="text-small-strong outline-none">
              {
                {
                  oauth: "Choose your account",
                  api_key: "Who issued your key?",
                  local: "Which app runs your model?",
                  other: "Other setup methods",
                }[method]
              }
            </h3>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {method === "local" ? (
              <>
                {action("LM Studio", { kind: "local", runtime: "lmstudio" }, "lmstudio")}
                {action("Ollama", { kind: "local", runtime: "ollama" }, "ollama")}
              </>
            ) : (
              choices.map((provider) =>
                action(
                  method === "oauth" && provider.id === "openai" ? "ChatGPT" : provider.label,
                  { kind: "builtin", provider, method: method === "other" ? undefined : method },
                  provider.id,
                ),
              )
            )}
            {(method === "other" || (method === "oauth" && !choices.some((p) => p.id === "openai"))) &&
              action("ChatGPT / Codex", { kind: "codex" }, "openai-codex")}
          </div>
          {method !== "local" && method !== "oauth" && choices.length === 0 && (
            <Text variant="small" color="secondary">
              No providers offer this setup method.
            </Text>
          )}
        </>
      ) : (
        <>
          <div className="grid gap-2">
            {methods.map((item) => (
              <Button
                key={item.id}
                variant="muted"
                disabled={disabled}
                className="h-auto justify-start gap-3 px-4 py-3 text-left"
                ref={(node) => {
                  triggers.current[item.id] = node;
                }}
                onClick={() => setMethod(item.id)}
              >
                <item.icon aria-hidden="true" className="size-5 shrink-0 text-secondary" />
                <span className="min-w-0 whitespace-normal">
                  <span className="block text-small-strong">{item.label}</span>
                  <span className="block text-small font-normal text-secondary">{item.hint}</span>
                </span>
              </Button>
            ))}
          </div>
          <details
            className="settings-card min-w-0"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
          >
            <summary className="cursor-pointer px-4 py-3 text-small-strong">Advanced connection</summary>
            <div className="grid gap-2 px-4 pb-3">
              {showEndpoints && action("Custom endpoint", { kind: "endpoint", template: "custom" }, "custom")}
              {showEndpoints &&
                action("Tailscale server", { kind: "endpoint", template: "tailnet" }, "tailscale")}
              <Button
                variant="filled"
                disabled={disabled}
                ref={(node) => {
                  triggers.current.other = node;
                }}
                onClick={() => setMethod("other")}
              >
                Other setup methods
              </Button>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
