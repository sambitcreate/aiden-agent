import { ChevronLeft, ChevronRight, Laptop, Lock, Sparkles, UserRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button, Input, Text, toast } from "./ui";
import { providersApi, profileApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import type { Provider } from "../lib/types";

const STORAGE_KEY = "aiden:onboarding:v1:complete";

type Step = "profile" | "provider" | "tour";
type ProviderChoice =
  | "openai-key"
  | "openai-signin"
  | "anthropic"
  | "lmstudio"
  | "ollama"
  | "tailscale";

const steps: Step[] = ["profile", "provider", "tour"];

const providerChoices: Array<{
  id: ProviderChoice;
  title: string;
  description: string;
  footnote: string;
  requiresKey?: boolean;
}> = [
  {
    id: "openai-key",
    title: "OpenAI API key",
    description: "Use an OpenAI-compatible hosted endpoint with your own API key.",
    footnote: "Key is saved through Aiden's local secret storage.",
    requiresKey: true,
  },
  {
    id: "openai-signin",
    title: "ChatGPT sign in",
    description: "Connect the built-in ChatGPT provider when you prefer browser sign-in.",
    footnote: "Aiden opens the provider auth flow outside the onboarding card.",
  },
  {
    id: "anthropic",
    title: "Anthropic API key",
    description: "Bring Claude with your Anthropic API key and provider-hosted models.",
    footnote: "The key stays on this Mac and can be rotated later in Settings.",
    requiresKey: true,
  },
  {
    id: "lmstudio",
    title: "LM Studio",
    description: "Use models served locally from LM Studio's OpenAI-compatible server.",
    footnote: "Default URL: http://127.0.0.1:1234/v1",
  },
  {
    id: "ollama",
    title: "Ollama",
    description: "Use local Ollama models through Aiden's OpenAI-compatible adapter.",
    footnote: "Default URL: http://127.0.0.1:11434/v1",
  },
  {
    id: "tailscale",
    title: "Tailscale custom model",
    description: "Point Aiden at a private OpenAI-compatible model reachable over Tailscale.",
    footnote: "Add your tailnet URL now; refine models later in Settings.",
  },
];

const featureBoxes = [
  [
    "Local profile",
    "Your name personalizes Profile and model-facing context while staying on-device.",
  ],
  ["Provider ready", "Start with one model source, then add more hosted or local providers later."],
  [
    "Workspace agents",
    "Chat, run terminal work, review files, and keep context beside the conversation.",
  ],
  [
    "Private by design",
    "Aiden stores local settings and secrets on this Mac rather than bundling credentials.",
  ],
  ["macOS polish", "Glass cards, quiet motion, keyboard focus, and sidebar-friendly navigation."],
  ["Bento overview", "Hover any tile to reveal how each capability fits into your daily flow."],
] as const;

export function shouldShowOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "true";
}

function makeProvider(choice: ProviderChoice, baseUrl: string): Omit<Provider, "hasKey"> | null {
  if (choice === "openai-signin") return null;
  if (choice === "openai-key") {
    return {
      id: "custom:onboarding-openai",
      kind: "openai",
      label: "OpenAI",
      baseUrl: baseUrl || "https://api.openai.com/v1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
      defaultModel: "gpt-4.1-mini",
      needsKey: true,
      deployment: "hosted",
    };
  }
  if (choice === "anthropic") {
    return {
      id: "custom:onboarding-anthropic",
      kind: "anthropic",
      label: "Anthropic",
      baseUrl: baseUrl || "https://api.anthropic.com/v1",
      models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
      defaultModel: "claude-sonnet-4-5",
      needsKey: true,
      deployment: "hosted",
    };
  }
  if (choice === "lmstudio") {
    return {
      id: "custom:onboarding-lmstudio",
      kind: "openai",
      label: "LM Studio (local)",
      baseUrl: baseUrl || "http://127.0.0.1:1234/v1",
      models: [],
      needsKey: false,
      deployment: "local",
    };
  }
  if (choice === "ollama") {
    return {
      id: "custom:onboarding-ollama",
      kind: "openai",
      label: "Ollama (local)",
      baseUrl: baseUrl || "http://127.0.0.1:11434/v1",
      models: [],
      needsKey: false,
      deployment: "local",
    };
  }
  return {
    id: "custom:onboarding-tailscale",
    kind: "openai",
    label: "Tailscale model",
    baseUrl,
    models: [],
    needsKey: false,
    deployment: "local",
  };
}

export function OnboardingFlow() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(() => shouldShowOnboarding());
  const [index, setIndex] = React.useState(0);
  const [name, setName] = React.useState("");
  const [choice, setChoice] = React.useState<ProviderChoice>("openai-signin");
  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  if (!open) return null;
  const step = steps[index];
  const selected = providerChoices.find((item) => item.id === choice)!;
  const canContinue = step !== "profile" || name.trim().length > 0;

  const next = async () => {
    if (!canContinue || saving) return;
    if (step === "profile") {
      setSaving(true);
      try {
        const saved = await profileApi.setName(name);
        queryClient.setQueryData(queryKeys.profile, saved);
        setIndex(1);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't save your profile name.");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (step === "provider") {
      const provider = makeProvider(choice, baseUrl.trim());
      if (choice === "tailscale" && !baseUrl.trim()) {
        toast.error("Enter the Tailscale model server URL before continuing.");
        return;
      }
      if (selected.requiresKey && !apiKey.trim()) {
        toast.error("Paste an API key or choose a sign-in/local option.");
        return;
      }
      setSaving(true);
      try {
        if (choice === "openai-signin") {
          await providersApi.authStart({
            flowId: `onboarding-${Date.now()}`,
            providerId: "openai-codex",
            authType: "oauth",
          });
          toast.info("Finish ChatGPT sign-in in the auth window, then continue.");
        } else if (provider) {
          const saved = await providersApi.save(
            provider,
            selected.requiresKey ? apiKey.trim() : undefined,
          );
          queryClient.setQueryData<Provider[]>(queryKeys.providers, (current) => {
            const without = (current ?? []).filter((item) => item.id !== saved.id);
            return [...without, saved];
          });
          toast.success(`${saved.label} added.`);
        }
        setIndex(2);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't add that provider.");
      } finally {
        setSaving(false);
      }
      return;
    }
    localStorage.setItem(STORAGE_KEY, "true");
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-60 grid place-items-center bg-background/72 p-6 backdrop-blur-2xl">
      <section className="relative grid max-h-[min(760px,calc(100vh-48px))] w-full max-w-5xl grid-cols-[0.92fr_1.08fr] overflow-hidden rounded-[28px] border border-field bg-popover shadow-modal max-[860px]:grid-cols-1">
        <div className="drag-region absolute left-0 right-0 top-0 h-10" />
        <aside className="relative overflow-hidden border-r border-separator bg-sidebar p-8 max-[860px]:hidden">
          <div className="absolute -left-20 -top-24 size-72 rounded-full bg-accent/20 blur-3xl" />
          <div className="absolute -bottom-24 right-4 size-72 rounded-full bg-control-active blur-3xl" />
          <div className="relative flex h-full flex-col justify-between">
            <div>
              <div className="grid size-14 place-items-center rounded-[18px] bg-accent text-accent-foreground shadow-control">
                <Sparkles />
              </div>
              <Text as="h1" variant="heading1" className="mt-7 block max-w-xs">
                Set up Aiden for your Mac
              </Text>
              <Text as="p" color="secondary" className="mt-3 block max-w-sm">
                A short onboarding flow for your local profile, first model provider, and the
                features that make Aiden feel at home on macOS.
              </Text>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {steps.map((item, itemIndex) => (
                <div
                  key={item}
                  className={`h-1.5 rounded-pill ${itemIndex <= index ? "bg-accent" : "bg-control"}`}
                />
              ))}
            </div>
          </div>
        </aside>
        <div className="flex min-h-[620px] flex-col p-7">
          <div className="flex items-center justify-between gap-4">
            <Text variant="small-strong" color="secondary">
              Step {index + 1} of {steps.length}
            </Text>
            <Button
              variant="transparent"
              size="small"
              onClick={() => {
                localStorage.setItem(STORAGE_KEY, "true");
                setOpen(false);
              }}
            >
              Skip
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto py-8">
            {step === "profile" ? (
              <div className="mx-auto max-w-lg">
                <div className="mb-5 grid size-12 place-items-center rounded-card bg-accent/12 text-accent">
                  <UserRound />
                </div>
                <Text as="h2" variant="heading1" className="block">
                  What should Aiden call you?
                </Text>
                <Text as="p" color="secondary" className="mt-2 block">
                  Your name is used only in Profile and model-facing personalization. This data
                  stays on this device.
                </Text>
                <label className="mt-8 block">
                  <Text variant="small-strong">Name</Text>
                  <Input
                    autoFocus
                    className="mt-2 h-10"
                    value={name}
                    maxLength={80}
                    placeholder="Your name"
                    onChange={(event) => setName(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void next();
                    }}
                  />
                </label>
                <div className="mt-5 flex items-center gap-2 rounded-card bg-well p-3">
                  <Lock className="size-4 text-accent" />
                  <Text variant="small" color="secondary">
                    Stored privately on this Mac.
                  </Text>
                </div>
              </div>
            ) : null}

            {step === "provider" ? (
              <div>
                <Text as="h2" variant="heading1" className="block">
                  Add your first model provider
                </Text>
                <Text as="p" color="secondary" className="mt-2 block">
                  Choose an API-key provider, ChatGPT sign-in, or a local/private model server.
                </Text>
                <div className="mt-6 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                  {providerChoices.map((item) => (
                    <button
                      key={item.id}
                      className={`rounded-card border p-4 text-left transition duration-150 hover:-translate-y-0.5 hover:bg-control hover:shadow-control-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring ${choice === item.id ? "border-accent bg-accent/10" : "border-field bg-well"}`}
                      onClick={() => setChoice(item.id)}
                    >
                      <Text variant="strong" className="block">
                        {item.title}
                      </Text>
                      <Text variant="small" color="secondary" className="mt-1 block">
                        {item.description}
                      </Text>
                      <Text variant="small" color="tertiary" className="mt-3 block">
                        {item.footnote}
                      </Text>
                    </button>
                  ))}
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
                  {selected.requiresKey ? (
                    <label>
                      <Text variant="small-strong">API key</Text>
                      <Input
                        className="mt-2"
                        type="password"
                        value={apiKey}
                        placeholder="Paste key"
                        onChange={(event) => setApiKey(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                  {choice === "tailscale" || choice === "openai-key" || choice === "anthropic" ? (
                    <label>
                      <Text variant="small-strong">Base URL</Text>
                      <Input
                        className="mt-2"
                        value={baseUrl}
                        placeholder={
                          choice === "tailscale"
                            ? "https://model.tailnet.ts.net/v1"
                            : "Default provider URL"
                        }
                        onChange={(event) => setBaseUrl(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === "tour" ? (
              <div>
                <Text as="h2" variant="heading1" className="block">
                  Aiden is ready
                </Text>
                <Text as="p" color="secondary" className="mt-2 block">
                  Hover each bento tile to learn what you can explore next.
                </Text>
                <div className="mt-6 grid auto-rows-[132px] grid-cols-3 gap-3 max-[760px]:grid-cols-2">
                  {featureBoxes.map(([title, description], boxIndex) => (
                    <article
                      key={title}
                      className={`group relative overflow-hidden rounded-[22px] border border-field bg-well p-4 shadow-control transition duration-150 hover:-translate-y-1 hover:bg-control hover:shadow-control-hover ${boxIndex === 0 || boxIndex === 5 ? "col-span-2" : ""}`}
                    >
                      <div className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-popover text-accent shadow-control">
                        {boxIndex % 2 === 0 ? (
                          <Sparkles className="size-4" />
                        ) : (
                          <Laptop className="size-4" />
                        )}
                      </div>
                      <Text variant="strong" className="block max-w-[70%]">
                        {title}
                      </Text>
                      <Text
                        variant="small"
                        color="secondary"
                        className="absolute bottom-4 left-4 right-4 translate-y-3 opacity-0 transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
                      >
                        {description}
                      </Text>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between border-t border-separator pt-5">
            <Button
              variant="transparent"
              disabled={index === 0 || saving}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
            >
              <ChevronLeft /> Back
            </Button>
            <Button variant="accent" disabled={!canContinue || saving} onClick={() => void next()}>
              {step === "tour" ? "Start using Aiden" : "Next"} <ChevronRight />
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
